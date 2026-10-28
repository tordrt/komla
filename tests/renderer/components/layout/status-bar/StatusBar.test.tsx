/**
 * @vitest-environment jsdom
 */
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { runCountdown } from '../../../../../src/renderer/components/layout/status-bar/AutomationsStatusSegment';
import { StatusBar } from '../../../../../src/renderer/components/layout/status-bar/StatusBar';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { DEFAULT_NOTIFICATION_SOUNDS } from '../../../../../src/renderer/lib/notification-sounds';
import { useActionsStore } from '../../../../../src/renderer/stores/actions.store';
import { useAutomationsStore } from '../../../../../src/renderer/stores/automations.store';
import { useCommandCenterStore } from '../../../../../src/renderer/stores/command-center.store';
import { useDevServerPreviewStore } from '../../../../../src/renderer/stores/dev-server-preview.store';
import {
  NEW_WORKSPACE_DIALOG_EVENT,
  useDialogsStore,
} from '../../../../../src/renderer/stores/dialogs.store';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';
import { useLayoutStore } from '../../../../../src/renderer/stores/layout.store';
import { resetNotesStore } from '../../../../../src/renderer/stores/notes.store';
import { useProjectsStore } from '../../../../../src/renderer/stores/projects.store';
import { useSettingsDialogStore } from '../../../../../src/renderer/stores/settings-dialog.store';
import { useSshHostDialogStore } from '../../../../../src/renderer/stores/ssh-host-dialog.store';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';
import { useStatusBarCustomizeStore } from '../../../../../src/renderer/stores/status-bar-customize.store';
import { resetStatusItemsStore } from '../../../../../src/renderer/stores/status-items.store';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';
import { useUpdateStore } from '../../../../../src/renderer/stores/update.store';
import { useWindowStore } from '../../../../../src/renderer/stores/window.store';
import { useWorkspaceObservationStore } from '../../../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';
import { createTerminal, createWorkspace } from '../../../../factories';

import type {
  SshForwardedPort,
  SshHostStatus,
  WorkspaceAttention,
  WorkspaceObservationProjection,
} from '../../../../../src/shared/types';
import type {
  Automation,
  AutomationRun,
  AutomationTargetSnapshot,
} from '../../../../../src/shared/types/automation';
import type { CommitGraph } from '../../../../../src/shared/types/commit-graph';
import type { AgentUsage, AgentUsageReading } from '../../../../../src/shared/types/agent-usage';
import type { AgentStatusItem } from '../../../../../src/shared/types/status-items';

const mockState = vi.hoisted(() => ({
  config: {} as Record<string, unknown> | null,
  updateConfig: vi.fn(),
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

// The branch items have their own tests; here they only take their place at the left.
vi.mock('../../../../../src/renderer/components/layout/UnifiedMenu', () => ({
  UnifiedMenu: () => <span>git menu</span>,
}));
vi.mock('../../../../../src/renderer/components/layout/TargetBranchSelector', () => ({
  TargetBranchSelector: () => <span>target branch</span>,
}));
vi.mock('../../../../../src/renderer/components/layout/GitProgressIndicator', () => ({
  GitProgressIndicator: () => <span>git progress</span>,
}));
vi.mock('../../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityIndicator: () => <span>setup progress</span>,
}));
// Tips has its own tests; here it only takes its place and hands over its hide link and hint.
vi.mock('../../../../../src/renderer/components/layout/GettingStartedMenu', () => ({
  GettingStartedMenu: ({
    onHideButton,
    onOpenChange,
    hideHint,
  }: {
    onHideButton?: () => void;
    onOpenChange: (open: boolean) => void;
    hideHint?: string;
  }) => (
    <>
      <button type="button" onClick={() => onOpenChange(true)}>
        Open Tips
      </button>
      <span>{hideHint}</span>
      <button type="button" onClick={onHideButton}>
        Tips
      </button>
    </>
  ),
}));

const notesMocks = vi.hoisted(() => ({ createNote: vi.fn(), openNote: vi.fn() }));

const actionMocks = vi.hoisted(() => ({ runAction: vi.fn() }));

vi.mock('../../../../../src/renderer/hooks/useActionLauncher', () => ({
  useActionLauncher: () => ({ runAction: actionMocks.runAction, actionInputDialog: null }),
}));

vi.mock('../../../../../src/renderer/lib/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/renderer/lib/notes')>()),
  ...notesMocks,
}));

const WINDOW_ID = 'window-1';

function attention(kind: WorkspaceAttention['kind']): WorkspaceAttention {
  return { kind, source: 'claude-code', updatedAt: 1 };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  Object.assign(window as any, {
    api: {
      platform: 'linux',
      getSystemMetrics: vi.fn(() => new Promise(() => {})),
      getSshHostStatuses: vi.fn(() => Promise.resolve([])),
      onSshHostStatusesChange: vi.fn(() => () => {}),
      checkSshHost: vi.fn(() => Promise.resolve(undefined)),
      listNotes: vi.fn(() => Promise.resolve([])),
      onNotesChanged: vi.fn(() => () => {}),
      listSshForwardedPorts: vi.fn(() => Promise.resolve([])),
      listStatusItems: vi.fn(() => Promise.resolve([])),
      onStatusItemsChange: vi.fn(() => () => {}),
      listStatusCommands: vi.fn(() => Promise.resolve({ items: [] })),
      runStatusCommand: vi.fn(() => new Promise(() => {})),
      onStatusCommandsChange: vi.fn(() => () => {}),
      onStatusCommandResult: vi.fn(() => () => {}),
      openExternal: vi.fn(() => Promise.resolve()),
      getAvailableEditors: vi.fn(() => Promise.resolve([])),
      getWorkspacePullRequestStatus: vi.fn(() => Promise.resolve({ kind: 'none' })),
      ...overrides,
    },
  });
}

function item(overrides: Partial<AgentStatusItem> = {}): AgentStatusItem {
  return {
    id: 'tests',
    workspaceId: 'ws-open',
    text: '142/150 passing',
    updatedAt: 1,
    ...overrides,
  };
}

function renderStatusBar() {
  return render(
    <TooltipProvider>
      <StatusBar />
    </TooltipProvider>
  );
}

/** The agents popover's rows: an agent, or a workspace with its agents. */
function agentRows(): Array<string | null> {
  return [...screen.getByRole('list', { name: 'Agents' }).children].map((row) => row.textContent);
}

function setWorkspaces(workspaces: ReturnType<typeof createWorkspace>[]) {
  useWorkspacesStore.setState({
    workspaces,
    hiddenWorkspaceHostIds: new Set(),
    hiddenProjectIds: new Set(),
    hideStopped: false,
  });
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'nightly',
    name: 'Nightly deps',
    prompt: 'Check dependencies',
    projectId: 'project-1',
    target: { kind: 'local' },
    // This computer's zone, so the list shows no zone beside the time.
    schedule: { cron: '0 9 * * *', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    enabled: true,
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function automationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'nightly',
    trigger: 'schedule',
    startedAt: Date.now() - 2 * 60 * 60 * 1000,
    status: 'started',
    ...overrides,
  };
}

function localAutomations(
  automations: Automation[],
  runs: Record<string, AutomationRun[]> = {}
): AutomationTargetSnapshot[] {
  return [{ target: { kind: 'local' }, automations, runs, scheduler: { available: true } }];
}

/** A time after every run so far, as when status-items.json changes after them. */
async function later(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 2));
  return Date.now();
}

describe('StatusBar', () => {
  beforeEach(() => {
    mockState.config = {};
    mockState.updateConfig = vi.fn();
    useWindowStore.setState({ windowId: WINDOW_ID });
    useUpdateStore.setState({ status: 'idle', version: null, dismissed: false });
    useToastStore.setState({ toasts: [] });
    setWorkspaces([]);
    useWorkspacesStore.setState({ selectedWorkspaceId: null });
    resetNotesStore();
    resetStatusItemsStore();
    notesMocks.createNote.mockReset();
    notesMocks.openNote.mockReset();
    useSshHostsStore.setState({ hosts: [] });
    useSettingsDialogStore.setState({ open: false, target: {} });
    useSshHostDialogStore.setState({ open: false, request: null, requestId: 0 });
    useStatusBarCustomizeStore.setState({ open: false, anchor: null });
    useActionsStore.setState({ actions: [] });
    useAutomationsStore.setState({ snapshots: [], automationNameByWorkspace: {} });
    mockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows by default and hides when switched off', () => {
    const { rerender } = renderStatusBar();
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();

    mockState.config = { showStatusBar: false };
    rerender(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.queryByTestId('status-bar')).not.toBeInTheDocument();
  });

  it("counts this window's workspaces that need input, failed, or are working", () => {
    const running = [createTerminal({ status: 'running' })];
    setWorkspaces([
      createWorkspace({ windowId: WINDOW_ID, attention: attention('input-required') }),
      createWorkspace({ windowId: WINDOW_ID, attention: attention('input-required') }),
      createWorkspace({ windowId: WINDOW_ID, attention: attention('error') }),
      createWorkspace({ windowId: WINDOW_ID, agentActive: true, terminals: running }),
      // Another window's workspace is not in this window's sidebar.
      createWorkspace({ windowId: 'window-2', attention: attention('input-required') }),
    ]);

    renderStatusBar();

    expect(
      screen.getByRole('button', { name: '2 need input, 1 error, 1 working' })
    ).toBeInTheDocument();
  });

  it('leaves out workspaces the sidebar hides', () => {
    setWorkspaces([
      createWorkspace({
        windowId: WINDOW_ID,
        projectId: 'hidden-project',
        attention: attention('input-required'),
      }),
    ]);
    useWorkspacesStore.setState({ hiddenProjectIds: new Set(['hidden-project']) });

    renderStatusBar();

    expect(screen.queryByRole('button', { name: /need/ })).not.toBeInTheDocument();
  });

  it('lists the agents under their states, most urgent first, and opens one from the list', async () => {
    const user = userEvent.setup();
    const selectWorkspace = vi.fn(() => Promise.resolve());
    const busy = createWorkspace({
      windowId: WINDOW_ID,
      name: 'busy',
      agentActive: true,
      terminals: [createTerminal({ status: 'running' })],
    });
    const waiting = createWorkspace({
      windowId: WINDOW_ID,
      name: 'waiting',
      attention: {
        ...attention('input-required'),
        message: 'Claude needs your permission',
        updatedAt: Date.now() - 5 * 60_000,
      },
    });
    setWorkspaces([busy, waiting]);
    // The workspace on screen is listed too; only the jump shortcut skips it.
    useWorkspacesStore.setState({ selectedWorkspaceId: waiting.id, selectWorkspace });

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input, 1 working' }));

    expect(agentRows()).toEqual(['Needs input:waiting5m', 'Working:busy']);

    await user.click(screen.getByRole('button', { name: 'Working:busy' }));
    expect(selectWorkspace).toHaveBeenCalledWith(busy.id);
    expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it('nests the agents of a workspace under its name, as their tabs show them', async () => {
    const user = userEvent.setup();
    setWorkspaces([
      createWorkspace({
        windowId: WINDOW_ID,
        name: 'busy',
        agentActive: true,
        terminals: [
          createTerminal({ status: 'running', agentActive: true, name: 'Claude Code' }),
          createTerminal({
            status: 'running',
            agentActive: true,
            name: 'Codex',
            dynamicTitle: 'Fixing the login test',
          }),
          createTerminal({
            status: 'running',
            agentActive: true,
            name: 'Reviewer',
            attention: {
              ...attention('input-required'),
              message: 'Allow git push?',
              updatedAt: Date.now() - 5 * 60_000,
            },
          }),
          // A stopped terminal's agent no longer works or waits.
          createTerminal({ status: 'stopped', attention: attention('error') }),
          createTerminal({ status: 'running', name: 'Shell' }),
        ],
      }),
    ]);

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input, 2 working' }));

    expect(agentRows()).toEqual([
      'busyNeeds input:Reviewer5mWorking:Claude CodeWorking:Fixing the login test',
    ]);
    const agents = within(screen.getByRole('list', { name: 'busy' })).getAllByRole('button');
    expect(agents.map((agent) => agent.textContent)).toEqual([
      'Needs input:Reviewer5m',
      'Working:Claude Code',
      'Working:Fixing the login test',
    ]);
  });

  it("opens an agent's own pane, in its tab, from the list", async () => {
    const user = userEvent.setup();
    const selectWorkspace = vi.fn(() => Promise.resolve());
    const busy = createWorkspace({
      windowId: WINDOW_ID,
      name: 'busy',
      agentActive: true,
      terminals: [
        createTerminal({ id: 'claude', status: 'running', agentActive: true, name: 'Claude' }),
        createTerminal({
          id: 'codex',
          status: 'running',
          name: 'Codex',
          attention: { ...attention('input-required'), message: 'Allow git push?' },
        }),
      ],
    });
    setWorkspaces([busy]);
    useWorkspacesStore.setState({ selectWorkspace });
    useLayoutStore.setState({
      tabsByWorkspace: { [busy.id]: ['claude', 'codex'] },
      layoutsByTab: {
        [busy.id]: {
          claude: { type: 'leaf', id: 'pane-claude', terminalId: 'claude' },
          codex: { type: 'leaf', id: 'pane-codex', terminalId: 'codex' },
        },
      },
      activeTabByWorkspace: { [busy.id]: 'claude' },
      focusedPaneByTab: {},
    });

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input, 1 working' }));
    await user.click(screen.getByRole('button', { name: /^Needs input:/ }));

    expect(useLayoutStore.getState().activeTabByWorkspace[busy.id]).toBe('codex');
    expect(useLayoutStore.getState().focusedPaneByTab[busy.id]).toEqual({ codex: 'pane-codex' });
    expect(selectWorkspace).toHaveBeenCalledWith(busy.id);
    expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it("shows the workspace's card on hover, with the agent's state, since when and all it said", async () => {
    const user = userEvent.setup();
    useProjectsStore.setState({ projects: [{ id: 'project-1', name: 'komla' } as never] });
    onTestFinished(() => useProjectsStore.setState({ projects: [] }));
    setWorkspaces([
      createWorkspace({
        windowId: WINDOW_ID,
        name: 'busy',
        projectId: 'project-1',
        branchName: 'fix-login',
        agentActive: true,
        terminals: [
          createTerminal({
            status: 'running',
            agentActive: true,
            name: 'Claude Code',
            dynamicTitle: 'Fixing the login test',
            agentActiveSince: Date.now() - 4 * 60_000,
          }),
        ],
      }),
    ]);

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 working' }));
    expect(agentRows()).toEqual(['Working:Fixing the login test4mkomla/fix-login']);
    await user.hover(screen.getByRole('button', { name: /Fixing the login test/ }));

    const card = await screen.findByRole('tooltip');
    expect(card).toHaveTextContent('Fixing the login test');
    expect(card).toHaveTextContent('Workingfor 4mClaude Code');
    // The row already tells the branch.
    expect(card).not.toHaveTextContent('fix-login');
  });

  it('counts finished agents the user has not seen', async () => {
    const user = userEvent.setup();
    setWorkspaces([
      createWorkspace({
        windowId: WINDOW_ID,
        name: 'busy',
        agentActive: true,
        terminals: [
          createTerminal({ status: 'running', agentActive: true, name: 'Claude Code' }),
          createTerminal({
            status: 'running',
            name: 'Codex',
            attention: { ...attention('turn-complete'), updatedAt: Date.now() - 2 * 60_000 },
          }),
          createTerminal({
            status: 'running',
            name: 'Reviewer',
            attention: { ...attention('turn-complete'), seen: true },
          }),
        ],
      }),
    ]);

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 done, 1 working' }));

    expect(agentRows()).toEqual(['busyDone:Codex2mWorking:Claude Code']);
  });

  it('clears finished agents from the agents list only, until another finishes', async () => {
    const user = userEvent.setup();
    const markTerminalAttentionSeen = vi.fn(() => Promise.resolve());
    const clearWorkspaceAttention = vi.fn(() => Promise.resolve());
    mockApi({ markTerminalAttentionSeen, clearWorkspaceAttention });
    const idle = createWorkspace({
      windowId: WINDOW_ID,
      name: 'idle',
      terminals: [
        createTerminal({
          id: 'codex',
          status: 'running',
          name: 'Codex',
          attention: { ...attention('turn-complete'), terminalId: 'codex' },
        }),
        createTerminal({
          id: 'reviewer',
          status: 'running',
          name: 'Reviewer',
          attention: { ...attention('input-required'), terminalId: 'reviewer' },
        }),
      ],
    });
    const legacy = createWorkspace({
      windowId: WINDOW_ID,
      name: 'legacy',
      attention: attention('turn-complete'),
    });
    setWorkspaces([idle, legacy]);

    const { unmount } = renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input, 2 done' }));
    await user.click(screen.getByRole('button', { name: 'Clear done' }));

    expect(mockState.updateConfig).toHaveBeenCalledWith({
      agentsDoneClearedAt: expect.any(Number),
    });
    // The sidebar and the agents' tabs still show them done.
    expect(markTerminalAttentionSeen).not.toHaveBeenCalled();
    expect(clearWorkspaceAttention).not.toHaveBeenCalled();
    unmount();

    mockState.config = { agentsDoneClearedAt: 1 };
    setWorkspaces([
      idle,
      legacy,
      createWorkspace({
        windowId: WINDOW_ID,
        name: 'later',
        attention: { ...attention('turn-complete'), updatedAt: 2 },
      }),
    ]);
    renderStatusBar();
    expect(screen.getByRole('button', { name: '1 needs input, 1 done' })).toBeInTheDocument();
  });

  it('sets up the macOS menu bar item from the agents list', async () => {
    const user = userEvent.setup();
    setWorkspaces([
      createWorkspace({ windowId: WINDOW_ID, attention: attention('input-required') }),
    ]);

    const { unmount } = renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input' }));
    expect(screen.queryByRole('button', { name: 'Menu bar settings' })).not.toBeInTheDocument();
    unmount();

    mockApi({ platform: 'darwin' });
    renderStatusBar();
    await user.click(screen.getByRole('button', { name: '1 needs input' }));
    await user.click(screen.getByRole('button', { name: 'Menu bar settings' }));
    const inBackground = screen.getByRole('menuitemcheckbox', {
      name: 'Only while Komla is in the background',
    });
    expect(inBackground).toBeChecked();
    expect(inBackground).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Show in the menu bar' }));
    expect(mockState.updateConfig).toHaveBeenCalledWith({ showAgentsInMenuBar: true });
  });

  it('hides agent activity the user turned off', () => {
    mockState.config = { statusBarHiddenItems: ['agents'] };
    setWorkspaces([
      createWorkspace({ windowId: WINDOW_ID, attention: attention('input-required') }),
    ]);

    renderStatusBar();

    expect(screen.queryByRole('button', { name: '1 needs input' })).not.toBeInTheDocument();
  });

  it('shows no automations item until there is an automation', () => {
    renderStatusBar();

    expect(screen.queryByRole('button', { name: /^Automations:/ })).not.toBeInTheDocument();
  });

  it('shows which automation runs next, and lists them all with their last run', async () => {
    const user = userEvent.setup();
    const snapshots = localAutomations(
      [automation(), automation({ id: 'triage', name: 'Issue triage', enabled: false })],
      { nightly: [automationRun()] }
    );
    const runWorkspace = createWorkspace({ id: 'ws-run', windowId: WINDOW_ID });
    setWorkspaces([runWorkspace]);
    const selectWorkspace = vi.fn(() => Promise.resolve());
    useWorkspacesStore.setState({ selectWorkspace });
    snapshots[0].runs.nightly[0].workspaceId = runWorkspace.id;
    useAutomationsStore.setState({ snapshots });
    mockApi({ listAutomations: vi.fn(() => Promise.resolve(snapshots)) });

    renderStatusBar();
    const button = screen.getByRole('button', { name: /^Automations: Nightly deps runs next/ });
    // The bar counts down; the tooltip has the date.
    expect(button).toHaveTextContent(/^in \d+[mhd]$/);
    await user.click(button);

    const list = screen.getByRole('list', { name: 'Automations' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent)
    ).toEqual([
      expect.stringMatching(/^Nightly depsEvery day at 09:00 · Next .*Ran 2h agoOpen$/),
      'Issue triageEvery day at 09:00 · Off',
    ]);
    expect(screen.getByText('1 of 2 on')).toBeInTheDocument();
    expect(window.api.listAutomations).toHaveBeenCalled();

    await user.click(within(list).getByRole('button', { name: 'Open' }));
    expect(selectWorkspace).toHaveBeenCalledWith(runWorkspace.id);
  });

  it('counts automations whose last run failed, and runs or turns one off from the list', async () => {
    const user = userEvent.setup();
    const snapshots = localAutomations([automation()], {
      nightly: [automationRun({ status: 'failed', message: 'Its project is gone.' })],
    });
    const runAutomationNow = vi.fn(() => Promise.resolve(automationRun({ id: 'run-2' })));
    const setAutomationEnabled = vi.fn(() => Promise.resolve());
    useAutomationsStore.setState({ snapshots });
    mockApi({
      listAutomations: vi.fn(() => Promise.resolve(snapshots)),
      runAutomationNow,
      setAutomationEnabled,
    });

    renderStatusBar();
    await user.click(
      screen.getByRole('button', { name: /^Automations: 1 failed · Nightly deps runs next/ })
    );

    expect(screen.getByText('Failed 2h ago: Its project is gone.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run Nightly deps now' }));
    expect(runAutomationNow).toHaveBeenCalledWith({ kind: 'local' }, 'nightly');
    await user.click(screen.getByRole('switch', { name: 'Turn off Nightly deps' }));
    expect(setAutomationEnabled).toHaveBeenCalledWith({ kind: 'local' }, 'nightly', false);

    await user.click(screen.getByRole('button', { name: 'Manage automations' }));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'automations' },
    });
  });

  it("doesn't count the failed last run of an automation that is off", () => {
    useAutomationsStore.setState({
      snapshots: localAutomations([automation({ enabled: false })], {
        nightly: [automationRun({ status: 'failed' })],
      }),
    });

    renderStatusBar();

    expect(
      screen.getByRole('button', { name: 'Automations: All automations are off' })
    ).toBeInTheDocument();
  });

  it('lists an automation that two targets both list once per target', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error');
    useSshHostsStore.setState({ hosts: [{ id: 'host-1', name: 'build-box' } as never] });
    useAutomationsStore.setState({
      snapshots: [
        ...localAutomations([automation()]),
        {
          target: { kind: 'ssh', hostId: 'host-1' },
          automations: [automation({ target: { kind: 'ssh', hostId: 'host-1' } })],
          runs: {},
          scheduler: { available: true },
        },
      ],
    });
    mockApi({ listAutomations: vi.fn(() => new Promise(() => {})) });

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: /^Automations:/ }));

    const rows = within(screen.getByRole('list', { name: 'Automations' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('build-box');
    expect(consoleError.mock.calls.map((call) => call.join(' '))).not.toContainEqual(
      expect.stringContaining('same key')
    );
  });

  it("shows a schedule's time zone when its clock differs from this computer's", async () => {
    const user = userEvent.setup();
    const offset = (timeZone: string) =>
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(0);
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeZone =
      offset(local) === offset('Pacific/Kiritimati') ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
    useAutomationsStore.setState({
      snapshots: localAutomations([
        automation({ schedule: { cron: '0 9 * * *', timeZone } }),
        automation({ id: 'here', name: 'Here', schedule: { cron: '0 9 * * *', timeZone: local } }),
      ]),
    });
    mockApi({ listAutomations: vi.fn(() => new Promise(() => {})) });

    renderStatusBar();
    await user.click(screen.getByRole('button', { name: /^Automations:/ }));

    const list = screen.getByRole('list', { name: 'Automations' });
    const city = timeZone.split('/')[1].replace('_', ' ');
    expect(
      within(list).getByText(new RegExp(`^Every day at 09:00 ${city} time · Next`))
    ).toBeInTheDocument();
    expect(within(list).getByText(/^Every day at 09:00 · Next/)).toBeInTheDocument();
  });

  it('brings back a dismissed update notice', () => {
    useUpdateStore.setState({ status: 'ready', version: '9.9.9', dismissed: true });

    renderStatusBar();
    fireEvent.click(screen.getByRole('button', { name: 'Komla v9.9.9 is ready to install' }));

    expect(useUpdateStore.getState().dismissed).toBe(false);
  });

  it('brings back a dismissed notice of a version to download', () => {
    useUpdateStore.setState({ status: 'manual', version: '9.9.9', dismissed: true });

    renderStatusBar();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Komla v9.9.9 is available to download' }));

    expect(useUpdateStore.getState().dismissed).toBe(false);
  });

  it('shows Komla resource usage only when turned on', async () => {
    const getSystemMetrics = vi.fn(() => Promise.resolve({ cpuPercent: 2.5, memoryMB: 321 }));
    mockApi({ getSystemMetrics });

    const { unmount } = renderStatusBar();
    expect(getSystemMetrics).not.toHaveBeenCalled();
    unmount();

    mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'komla' };
    renderStatusBar();
    expect(await screen.findByText('321 MB')).toBeInTheDocument();
  });

  it("separates Komla's own resource usage from each workspace's, here and on SSH hosts", async () => {
    const user = userEvent.setup();
    const selectWorkspace = vi.fn(() => Promise.resolve());
    const local = createWorkspace({
      windowId: WINDOW_ID,
      name: 'local-app',
      terminals: [
        createTerminal({ id: 'shell', name: 'Shell', status: 'running' }),
        createTerminal({ id: 'tests', name: 'Tests', status: 'running' }),
      ],
    });
    const remote = createWorkspace({
      windowId: WINDOW_ID,
      name: 'remote-api',
      backend: {
        kind: 'ssh',
        hostId: 'devbox',
        remoteDirectory: '/r',
        remoteRepoPath: '/r',
        remoteProjectRoot: '/r',
        gitUrl: '',
      },
      terminals: [createTerminal({ id: 'agent', status: 'running' })],
    });
    setWorkspaces([local, remote]);
    useWorkspacesStore.setState({ selectWorkspace });
    useSshHostsStore.setState({
      hosts: [{ id: 'devbox', name: 'devbox', hostname: 'devbox.lan', basePath: '~/.komla' }],
    });
    const usage = (cpuPercent: number | null, memoryBytes: number) => ({ cpuPercent, memoryBytes });
    const localUsage = {
      machine: {
        cores: 8,
        cpuPercent: 154,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryAvailableBytes: 6 * 1024 ** 3,
      },
      komla: [
        { kind: 'main', ...usage(1, 200 * 1024 ** 2), processCount: 1 },
        { kind: 'windows', ...usage(2, 300 * 1024 ** 2), processCount: 2 },
        { kind: 'helpers', ...usage(0, 100 * 1024 ** 2), processCount: 3 },
        { kind: 'background', ...usage(1, 24 * 1024 ** 2), processCount: 4 },
      ],
      workspaces: [
        {
          workspaceId: local.id,
          ...usage(130, 1.5 * 1024 ** 3),
          terminals: [
            { terminalId: 'tests', ...usage(120, 1024 ** 3) },
            { terminalId: 'shell', ...usage(10, 0.5 * 1024 ** 3) },
          ],
        },
      ],
      otherProcesses: usage(20, 4 * 1024 ** 3),
    };
    const devboxUsage = {
      hostId: 'devbox',
      machine: {
        cores: 16,
        cpuPercent: null,
        memoryTotalBytes: null,
        memoryAvailableBytes: null,
      },
      komla: [
        { kind: 'tmux-server', ...usage(null, 12 * 1024 ** 2), processCount: 1 },
        { kind: 'connections', ...usage(null, 90 * 1024 ** 2), processCount: 10 },
      ],
      workspaces: [
        {
          workspaceId: remote.id,
          ...usage(null, 3 * 1024 ** 3),
          terminals: [{ terminalId: 'agent', ...usage(null, 3 * 1024 ** 3) }],
        },
      ],
      otherSessions: { ...usage(5, 200 * 1024 ** 2), count: 2 },
      otherProcesses: usage(null, 0),
    };
    const getResourceUsage = vi.fn((hostId: string | null) =>
      Promise.resolve(hostId === null ? localUsage : devboxUsage)
    );
    mockApi({
      getSystemMetrics: vi.fn(() => Promise.resolve({ cpuPercent: 3, memoryMB: 600 })),
      getResourceUsage,
    });
    mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'komla' };
    renderStatusBar();

    await user.click(await screen.findByRole('button', { name: /^Resource usage/ }));

    expect(getResourceUsage).toHaveBeenCalledWith(null, { prompt: true, maxAgeMs: undefined });
    expect(getResourceUsage).toHaveBeenCalledWith('devbox', { prompt: true, maxAgeMs: undefined });
    const here = await screen.findByRole('region', { name: 'This computer' });
    // By the machine's own count.
    await vi.waitFor(() => expect(here).toHaveTextContent('1.5 of 8 cores busy'));
    expect(here).toHaveTextContent('10.0 GB of 16.0 GB used');
    // Split between workspaces, Komla and the rest of what the machine uses.
    expect(within(here).getByTitle('Workspaces: 130%')).toBeVisible();
    expect(within(here).getByTitle('Other: 20%')).toBeVisible();
    expect(within(here).getByTitle('Komla: 624 MB')).toBeVisible();
    expect(within(here).getByTitle('Other: 7.9 GB')).toBeVisible();
    const komla = within(here).getByRole('region', { name: 'Komla' });
    expect(komla).toHaveTextContent('Komla4%624 MB');
    // Its own processes fold away until asked for.
    expect(komla).not.toHaveTextContent('Windows and browser tabs');
    await user.click(within(here).getByRole('button', { name: 'Show what Komla runs' }));
    expect(komla).toHaveTextContent('Windows and browser tabs2%300 MB');
    expect(komla).toHaveTextContent('Background processes1%24 MB');
    const workspaces = within(here).getByRole('region', { name: 'Workspaces' });
    expect(workspaces).toHaveTextContent('Workspaces130%1.5 GB');
    expect(workspaces).toHaveTextContent('local-app130%1.5 GB');
    expect(here).toHaveTextContent('Other processes20%4.0 GB');
    await user.click(screen.getByRole('button', { name: 'Show what local-app runs' }));
    expect(here).toHaveTextContent('Tests120%1.0 GB');

    const devbox = screen.getByRole('region', { name: 'devbox' });
    // The first read of a host has no CPU yet, and nothing for its processes to add up.
    expect(devbox).toHaveTextContent('16 cores');
    expect(devbox).not.toHaveTextContent('busy');
    await user.click(within(devbox).getByRole('button', { name: 'Show what Komla runs' }));
    expect(within(devbox).getByRole('region', { name: 'Komla' })).toHaveTextContent(
      'Terminal connections (10)–90 MB'
    );
    const remoteWorkspaces = within(devbox).getByRole('region', { name: 'Workspaces' });
    expect(remoteWorkspaces).toHaveTextContent('remote-api–3.0 GB');
    expect(remoteWorkspaces).toHaveTextContent('Other sessions (2)5%200 MB');

    await user.click(screen.getByRole('button', { name: 'remote-api' }));
    expect(selectWorkspace).toHaveBeenCalledWith(remote.id);
  });

  describe('what the bar shows', () => {
    const devbox = { id: 'devbox', name: 'devbox', hostname: 'devbox.lan', basePath: '~/.komla' };
    const usage = (cpuPercent: number | null, memoryBytes: number) => ({ cpuPercent, memoryBytes });
    const machineUsage = (cores: number, cpuPercent: number | null) => ({
      machine: {
        cores,
        cpuPercent,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryAvailableBytes: 6 * 1024 ** 3,
      },
      komla: [
        { kind: 'main', ...usage(1, 200 * 1024 ** 2), processCount: 1 },
        { kind: 'windows', ...usage(2, 300 * 1024 ** 2), processCount: 2 },
      ],
      workspaces: [{ workspaceId: 'ws', ...usage(130.4, 1.5 * 1024 ** 3), terminals: [] }],
      otherProcesses: usage(20, 4 * 1024 ** 3),
    });

    function mockReads() {
      const getSystemMetrics = vi.fn(() => Promise.resolve({ cpuPercent: 3, memoryMB: 600 }));
      const getResourceUsage = vi.fn((hostId: string | null) =>
        Promise.resolve(hostId === null ? machineUsage(8, 154) : machineUsage(16, 400))
      );
      mockApi({ getSystemMetrics, getResourceUsage });
      return { getSystemMetrics, getResourceUsage };
    }

    const bar = () => screen.getByRole('button', { name: /^Resource usage/ });

    it("shows Komla's own when picked", async () => {
      const { getResourceUsage } = mockReads();
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'komla' };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('3.0%·600 MB'));
      expect(getResourceUsage).not.toHaveBeenCalled();
    });

    it('adds up Komla and the workspaces on this computer by default', async () => {
      const { getSystemMetrics, getResourceUsage } = mockReads();
      mockState.config = { showSystemMetrics: true };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('133.4%·2.0 GB'));
      expect(getResourceUsage).toHaveBeenCalledWith(null, { prompt: false, maxAgeMs: 4500 });
      expect(getSystemMetrics).not.toHaveBeenCalled();
    });

    it('reads less often on Windows, where each read starts PowerShell or an ssh connection', async () => {
      const { getResourceUsage } = mockReads();
      (window as any).api.platform = 'win32';
      mockState.config = { showSystemMetrics: true };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('133.4%·2.0 GB'));
      expect(getResourceUsage).toHaveBeenCalledWith(null, { prompt: false, maxAgeMs: 14_500 });
    });

    it('shows the whole computer as a share of its cores and memory', async () => {
      mockReads();
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'computer' };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('19%·10.0/16 GB'));
    });

    it("shows an SSH host, named in the tooltip, and this computer's once it's gone", async () => {
      const { getResourceUsage } = mockReads();
      useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
      mockState.config = {
        showSystemMetrics: true,
        statusBarResourceUsage: 'ssh-host',
        statusBarResourceUsageHostId: 'devbox',
      };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent(/^25%·10.0\/16 GB$/));
      expect(bar()).toHaveAccessibleName(/^Resource usage: devbox: /);
      expect(getResourceUsage).toHaveBeenCalledWith('devbox', { prompt: false, maxAgeMs: 4500 });

      act(() => useSshHostsStore.setState({ hosts: [] }));
      await vi.waitFor(() => expect(bar()).toHaveTextContent('133.4%·2.0 GB'));
    });

    it("adds up Komla and the workspaces on an SSH host, other devices' sessions too", async () => {
      mockApi({
        getResourceUsage: vi.fn((hostId: string | null) =>
          Promise.resolve({
            ...machineUsage(16, 400),
            hostId,
            otherSessions: { ...usage(10, 512 * 1024 ** 2), count: 2 },
          })
        ),
      });
      useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
      mockState.config = {
        showSystemMetrics: true,
        statusBarResourceUsage: 'ssh-host-workspaces',
        statusBarResourceUsageHostId: 'devbox',
      };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('143.4%·2.5 GB'));
      expect(bar()).toHaveAccessibleName(
        'Resource usage: Komla and what its terminals run on devbox: 143.4% CPU, 2.5 GB'
      );
    });

    it('shows a host that answers with an error without numbers', async () => {
      mockApi({
        getSystemMetrics: vi.fn(() => Promise.resolve({ cpuPercent: 3, memoryMB: 600 })),
        getResourceUsage: vi.fn(() =>
          Promise.resolve({
            ...machineUsage(16, null),
            hostId: 'devbox',
            error: "Command failed: ssh devbox sh -lc '…'\nssh: Connection refused\n",
          })
        ),
      });
      useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
      mockState.config = {
        showSystemMetrics: true,
        statusBarResourceUsage: 'ssh-host',
        statusBarResourceUsageHostId: 'devbox',
      };
      renderStatusBar();

      await vi.waitFor(() =>
        expect(bar()).toHaveAccessibleName(
          "Resource usage: devbox couldn't be read: ssh: Connection refused: – CPU, –"
        )
      );
      expect(bar()).toHaveTextContent(/^–·–$/);
    });

    it('reads again later after a failed read, and not while the window is hidden', async () => {
      vi.useFakeTimers();
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      try {
        const getResourceUsage = vi.fn(() =>
          Promise.resolve({ ...machineUsage(16, null), hostId: 'devbox', error: 'ssh: refused' })
        );
        mockApi({ getResourceUsage });
        useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
        mockState.config = {
          showSystemMetrics: true,
          statusBarResourceUsage: 'ssh-host',
          statusBarResourceUsageHostId: 'devbox',
        };
        renderStatusBar();
        await act(async () => {});
        expect(getResourceUsage).toHaveBeenCalledTimes(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(29_000);
        });
        expect(getResourceUsage).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(getResourceUsage).toHaveBeenCalledTimes(2);

        hidden.mockReturnValue(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        expect(getResourceUsage).toHaveBeenCalledTimes(2);
        hidden.mockReturnValue(false);
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(getResourceUsage).toHaveBeenCalledTimes(3);
      } finally {
        hidden.mockRestore();
        vi.useRealTimers();
      }
    });

    it("shows Komla's own when this computer's processes can't be read", async () => {
      mockApi({
        getResourceUsage: vi.fn(() =>
          Promise.resolve({ ...machineUsage(8, null), workspaces: [], error: 'ps: not found' })
        ),
      });
      mockState.config = { showSystemMetrics: true };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('3.0%·500 MB'));
      expect(bar()).toHaveAccessibleName(
        "Resource usage: Komla's own CPU and memory. This computer couldn't be read: ps: not found: 3.0% CPU, 500 MB"
      );
    });

    it('starts from nothing when switched back, rather than from an old reading', async () => {
      mockReads();
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'computer' };
      const { rerender } = renderStatusBar();
      await vi.waitFor(() => expect(bar()).toHaveTextContent('19%·10.0/16 GB'));

      const rerenderBar = () =>
        rerender(
          <TooltipProvider>
            <StatusBar />
          </TooltipProvider>
        );
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'komla' };
      rerenderBar();
      await vi.waitFor(() => expect(bar()).toHaveTextContent('3.0%·600 MB'));
      window.api.getResourceUsage = vi.fn(() => new Promise(() => {}));
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'computer' };
      rerenderBar();
      expect(bar()).toHaveTextContent(/^–·–$/);
    });

    it("falls back to this computer when the SSH hosts couldn't load", async () => {
      mockReads();
      useSshHostsStore.setState({ hosts: [], hasLoaded: false, error: 'IPC failed' });
      mockState.config = {
        showSystemMetrics: true,
        statusBarResourceUsage: 'ssh-host',
        statusBarResourceUsageHostId: 'devbox',
      };
      renderStatusBar();

      await vi.waitFor(() => expect(bar()).toHaveTextContent('133.4%·2.0 GB'));
    });

    it("reads the bar's host in the popover, where it can ask for a password", async () => {
      const user = userEvent.setup();
      const { getResourceUsage } = mockReads();
      useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
      mockState.config = {
        showSystemMetrics: true,
        statusBarResourceUsage: 'ssh-host',
        statusBarResourceUsageHostId: 'devbox',
      };
      renderStatusBar();

      await user.click(bar());
      expect(await screen.findByRole('region', { name: 'devbox' })).toBeInTheDocument();
      expect(getResourceUsage).toHaveBeenCalledWith('devbox', {
        prompt: true,
        maxAgeMs: undefined,
      });
    });

    it('is picked in the popover, among SSH hosts too', async () => {
      const user = userEvent.setup();
      mockReads();
      useSshHostsStore.setState({ hosts: [devbox], hasLoaded: true });
      mockState.config = { showSystemMetrics: true };
      renderStatusBar();

      await user.click(bar());
      const picker = await screen.findByRole('button', {
        name: 'Status bar shows: Komla and workspaces',
      });
      await user.click(picker);
      expect(screen.getByRole('menuitemradio', { name: 'Komla and workspaces' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      await user.click(screen.getByRole('menuitemradio', { name: 'devbox: Komla and workspaces' }));
      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarResourceUsage: 'ssh-host-workspaces',
        statusBarResourceUsageHostId: 'devbox',
      });

      await user.click(picker);
      await user.click(screen.getByRole('menuitemradio', { name: 'devbox: Everything' }));
      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarResourceUsage: 'ssh-host',
        statusBarResourceUsageHostId: 'devbox',
      });

      await user.click(picker);
      await user.click(screen.getByRole('menuitemradio', { name: 'This computer' }));
      expect(mockState.updateConfig).toHaveBeenCalledWith({ statusBarResourceUsage: 'computer' });
    });
  });

  it('shows each machine as it answers, and reads it again only after an answer', async () => {
    vi.useFakeTimers();
    try {
      setWorkspaces([
        createWorkspace({
          windowId: WINDOW_ID,
          backend: {
            kind: 'ssh',
            hostId: 'devbox',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: '',
          },
        }),
      ]);
      useSshHostsStore.setState({
        hosts: [{ id: 'devbox', name: 'devbox', hostname: 'devbox.lan', basePath: '~/.komla' }],
      });
      const getResourceUsage = vi.fn((hostId: string | null) =>
        hostId === null
          ? Promise.resolve({
              machine: {
                cores: 4,
                cpuPercent: null,
                memoryTotalBytes: null,
                memoryAvailableBytes: null,
              },
              komla: [],
              workspaces: [],
              otherProcesses: { cpuPercent: null, memoryBytes: 0 },
            })
          : // A host that doesn't answer.
            new Promise(() => {})
      );
      mockApi({
        getSystemMetrics: vi.fn(() => Promise.resolve({ cpuPercent: 3, memoryMB: 600 })),
        getResourceUsage,
      });
      mockState.config = { showSystemMetrics: true, statusBarResourceUsage: 'komla' };
      renderStatusBar();
      await act(async () => {});

      fireEvent.click(screen.getByRole('button', { name: /^Resource usage/ }));
      await act(async () => {});

      expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('4 cores');
      expect(screen.getByRole('region', { name: 'devbox' })).toHaveTextContent('Reading…');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const reads = (hostId: string | null) =>
        getResourceUsage.mock.calls.filter(([id]) => id === hostId).length;
      expect(reads(null)).toBe(3);
      expect(reads('devbox')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('SSH hosts', () => {
    const devbox = { id: 'devbox', name: 'devbox', hostname: 'devbox.lan', basePath: '~/.komla' };
    const gpu = { id: 'gpu', name: 'gpu-box', hostname: 'gpu.lan', basePath: '~/.komla' };
    const statuses: SshHostStatus[] = [
      { hostId: 'devbox', state: 'connected', checkedAt: Date.now() },
      {
        hostId: 'gpu',
        state: 'unreachable',
        checkedAt: 1,
        message: 'ssh: connect to host gpu.lan port 22: Connection refused',
      },
    ];

    it('hides once turned off', () => {
      mockState.config = { statusBarHiddenItems: ['ssh-hosts'] };
      useSshHostsStore.setState({ hosts: [devbox] });

      renderStatusBar();

      expect(screen.queryByRole('button', { name: /^SSH hosts/ })).not.toBeInTheDocument();
    });

    it('stays hidden without SSH hosts', () => {
      renderStatusBar();

      expect(screen.queryByRole('button', { name: /^SSH hosts/ })).not.toBeInTheDocument();
    });

    it('counts hosts not checked since Komla started', () => {
      useSshHostsStore.setState({ hosts: [devbox] });

      renderStatusBar();

      expect(screen.getByRole('button', { name: 'SSH hosts: 1 not checked' })).toHaveTextContent(
        'devbox'
      );
    });

    it('counts several hosts as one item', () => {
      useSshHostsStore.setState({ hosts: [devbox, gpu] });

      renderStatusBar();

      expect(screen.getByRole('button', { name: 'SSH hosts: 2 not checked' })).toHaveTextContent(
        /^2 hosts$/
      );
    });

    it('shows unreachable hosts, with why, and checks one again', async () => {
      useSshHostsStore.setState({ hosts: [devbox, gpu] });
      mockApi({ getSshHostStatuses: vi.fn(() => Promise.resolve(statuses)) });
      setWorkspaces([
        createWorkspace({
          windowId: WINDOW_ID,
          backend: {
            kind: 'ssh',
            hostId: 'gpu',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: '',
          },
        }),
      ]);
      renderStatusBar();

      const button = await screen.findByRole('button', {
        name: 'SSH hosts: 1 connected, 1 unreachable',
      });
      expect(button).toHaveTextContent('1 unreachable');
      fireEvent.click(button);

      expect(screen.getByText('Connected just now')).toBeInTheDocument();
      expect(
        screen.getByText('ssh: connect to host gpu.lan port 22: Connection refused')
      ).toBeInTheDocument();
      expect(screen.getByText('0 of 1 workspace active')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Check gpu-box' }));
      });
      expect(window.api.checkSshHost).toHaveBeenCalledWith('gpu');
    });

    it('lists what runs on each host, with its agents, and opens a workspace', async () => {
      const user = userEvent.setup();
      const selectWorkspace = vi.fn(() => Promise.resolve());
      const onDevbox = (overrides: Parameters<typeof createWorkspace>[0]) =>
        createWorkspace({
          windowId: WINDOW_ID,
          backend: {
            kind: 'ssh',
            hostId: 'devbox',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: '',
          },
          ...overrides,
        });
      const running = () => createTerminal({ status: 'running' });
      const busy = onDevbox({ name: 'busy', agentActive: true, terminals: [running(), running()] });
      setWorkspaces([
        busy,
        onDevbox({
          name: 'waiting',
          attention: attention('input-required'),
          terminals: [running()],
        }),
        onDevbox({ name: 'parked', terminals: [createTerminal({ status: 'stopped' })] }),
      ]);
      useSshHostsStore.setState({ hosts: [devbox] });
      useWorkspacesStore.setState({ selectWorkspace });
      renderStatusBar();

      const button = screen.getByRole('button', { name: 'SSH hosts: 1 not checked, 2 active' });
      // The bar keeps to the host; the popover counts what runs there.
      expect(button).toHaveTextContent(/^devbox$/);
      await user.click(button);

      expect(
        screen.getByText('2 of 3 workspaces active · 1 needs input · 1 working')
      ).toBeInTheDocument();
      const list = screen.getByRole('list', { name: 'Active on devbox' });
      expect(list).toHaveTextContent('busy2 sessions');
      expect(list).toHaveTextContent('waiting1 session');
      expect(list).not.toHaveTextContent('parked');

      await user.click(screen.getByRole('button', { name: /busy/ }));
      expect(selectWorkspace).toHaveBeenCalledWith(busy.id);
    });

    it("brings forward the window that shows another window's workspace", async () => {
      const user = userEvent.setup();
      const selectWorkspace = vi.fn(() => Promise.resolve());
      const focusWorkspaceWindow = vi.fn(() => Promise.resolve(true));
      const elsewhere = createWorkspace({
        name: 'elsewhere',
        windowId: 'window-2',
        backend: {
          kind: 'ssh',
          hostId: 'devbox',
          remoteDirectory: '/r',
          remoteRepoPath: '/r',
          remoteProjectRoot: '/r',
          gitUrl: '',
        },
        terminals: [createTerminal({ status: 'running' })],
      });
      setWorkspaces([elsewhere]);
      useSshHostsStore.setState({ hosts: [devbox] });
      useWorkspacesStore.setState({ selectWorkspace });
      mockApi({ focusWorkspaceWindow });
      renderStatusBar();

      await user.click(screen.getByRole('button', { name: 'SSH hosts: 1 not checked, 1 active' }));
      await user.click(screen.getByRole('button', { name: /elsewhere/ }));

      expect(focusWorkspaceWindow).toHaveBeenCalledWith(elsewhere.id, undefined);
      expect(selectWorkspace).not.toHaveBeenCalled();
    });

    it('lists the ports forwarded for each host, and stops those Komla can do without', async () => {
      const user = userEvent.setup();
      const app = createWorkspace({
        name: 'app',
        windowId: WINDOW_ID,
        backend: {
          kind: 'ssh',
          hostId: 'devbox',
          remoteDirectory: '/r',
          remoteRepoPath: '/r',
          remoteProjectRoot: '/r',
          gitUrl: '',
        },
      });
      const elsewhere = createWorkspace({
        name: 'elsewhere',
        windowId: 'window-2',
        backend: app.backend,
      });
      setWorkspaces([app, elsewhere]);
      useSshHostsStore.setState({ hosts: [devbox] });
      const forwarded = (port: Partial<SshForwardedPort>): SshForwardedPort => ({
        id: 'port',
        hostId: 'devbox',
        kind: 'link',
        direction: 'remote-to-local',
        localPort: 3000,
        remotePort: 3000,
        ...port,
      });
      const listSshForwardedPorts = vi.fn(() =>
        Promise.resolve([
          forwarded({ id: 'link-1', kind: 'link', workspaceId: app.id, state: 'stopped' }),
          forwarded({
            id: 'tab-forward',
            kind: 'browser-tab',
            workspaceId: app.id,
            tabId: 'tab-1',
            localPort: 5174,
            remotePort: 5173,
          }),
          forwarded({
            id: 'other-window-tab',
            kind: 'browser-tab',
            workspaceId: elsewhere.id,
            tabId: 'tab-2',
            localPort: 8081,
            remotePort: 8080,
          }),
          forwarded({ id: 'desktop', kind: 'desktop', localPort: 5901, remotePort: 5901 }),
          forwarded({
            id: 'saved',
            kind: 'saved',
            direction: 'local-to-remote',
            localPort: 5432,
            remotePort: 15432,
            name: 'PostgreSQL',
            state: 'connected',
          }),
          forwarded({
            id: 'komla',
            kind: 'komla',
            direction: 'local-to-remote',
            localPort: 54183,
            remotePort: 62042,
          }),
          forwarded({ id: 'elsewhere', hostId: 'gpu', remotePort: 8888, localPort: 8888 }),
        ])
      );
      const stopSshLinkForward = vi.fn(() => Promise.resolve());
      const stopSshDesktopForward = vi.fn(() => Promise.resolve());
      const stopSshPreviewForward = vi.fn(() => Promise.resolve());
      const realStopSshPreviewForward = useDevServerPreviewStore.getState().stopSshPreviewForward;
      useDevServerPreviewStore.setState({ stopSshPreviewForward });
      onTestFinished(() =>
        useDevServerPreviewStore.setState({ stopSshPreviewForward: realStopSshPreviewForward })
      );
      mockApi({ listSshForwardedPorts, stopSshLinkForward, stopSshDesktopForward });
      renderStatusBar();

      await user.click(screen.getByRole('button', { name: /^SSH hosts/ }));

      const ports = await screen.findByRole('list', { name: 'Ports forwarded for devbox' });
      const rows = within(ports).getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual([
        '3000 → localhost:3000Link · app · stoppedStop',
        '5173 → localhost:5174Browser tab · appStop',
        // Its window's browser shows whether its tunnel runs, so it's stopped there.
        '8080 → localhost:8081Browser tab · elsewhere',
        '5901 → localhost:5901Desktop :1Stop',
        'localhost:5432 → 15432PostgreSQLEdit',
        'localhost:54183 → 62042Komla · notifications and data',
      ]);
      expect(rows[0]).toHaveAttribute('title', 'Port 3000 on devbox, at localhost:3000 here');
      expect(rows[4]).toHaveAttribute('title', 'localhost:5432 here, at port 15432 on devbox');

      await user.click(within(rows[0]).getByRole('button', { name: 'Stop forwarding port 3000' }));
      expect(stopSshLinkForward).toHaveBeenCalledWith(app.id, 'link-1');
      await vi.waitFor(() => expect(listSshForwardedPorts).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: 'Stop forwarding port 5173' }));
      expect(stopSshPreviewForward).toHaveBeenCalledWith(app.id, {
        tabId: 'tab-1',
        keepStopped: true,
      });
      await user.click(screen.getByRole('button', { name: 'Stop forwarding port 5901' }));
      expect(stopSshDesktopForward).toHaveBeenCalledWith('devbox', 5901);

      await user.click(screen.getByRole('button', { name: 'Edit PostgreSQL' }));
      expect(useSshHostDialogStore.getState()).toMatchObject({
        open: true,
        request: { kind: 'edit', hostId: 'devbox' },
      });
    });

    it('shows no ports from an earlier opening while it reads them again', async () => {
      const user = userEvent.setup();
      useSshHostsStore.setState({ hosts: [devbox] });
      const listSshForwardedPorts = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'desktop',
            hostId: 'devbox',
            kind: 'desktop',
            direction: 'remote-to-local',
            localPort: 5901,
            remotePort: 5901,
          },
        ])
        .mockReturnValue(new Promise(() => {}));
      mockApi({ listSshForwardedPorts });
      renderStatusBar();
      const hostsButton = screen.getByRole('button', { name: /^SSH hosts/ });

      await user.click(hostsButton);
      await screen.findByRole('list', { name: 'Ports forwarded for devbox' });
      await user.keyboard('{Escape}');
      await user.click(hostsButton);

      expect(listSshForwardedPorts).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('list', { name: 'Ports forwarded for devbox' })).toBeNull();
    });

    it('follows status changes and opens SSH settings', async () => {
      let push: (next: SshHostStatus[]) => void = () => {};
      useSshHostsStore.setState({ hosts: [gpu] });
      mockApi({
        onSshHostStatusesChange: vi.fn((callback: (next: SshHostStatus[]) => void) => {
          push = callback;
          return () => {};
        }),
      });
      renderStatusBar();

      act(() => push(statuses));
      fireEvent.click(screen.getByRole('button', { name: 'SSH hosts: 1 unreachable' }));
      fireEvent.click(screen.getByRole('button', { name: 'Manage SSH hosts…' }));

      expect(useSettingsDialogStore.getState()).toMatchObject({
        open: true,
        target: { tab: 'ssh' },
      });
    });

    it('adds an SSH host from the menu', () => {
      useSshHostsStore.setState({ hosts: [devbox] });
      renderStatusBar();

      fireEvent.click(screen.getByRole('button', { name: /^SSH hosts/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Add SSH host…' }));

      expect(useSshHostDialogStore.getState()).toMatchObject({
        open: true,
        request: { kind: 'add', source: 'settings' },
      });
      expect(screen.queryByText('Add SSH host…')).not.toBeInTheDocument();
    });
  });

  describe('keep awake', () => {
    beforeEach(() => {
      mockState.config = { statusBarShownItems: ['keep-awake'] };
    });

    it("counts every window's agents working on this computer, as it stays awake for all of them", () => {
      mockState.config = { keepAwakeMode: 'agents', statusBarShownItems: ['keep-awake'] };
      setWorkspaces([
        createWorkspace({
          windowId: 'window-2',
          agentActive: true,
          terminals: [createTerminal({ status: 'running' })],
        }),
        // Works on in tmux on the host while this computer sleeps.
        createWorkspace({
          windowId: WINDOW_ID,
          agentActive: true,
          backend: {
            kind: 'ssh',
            hostId: 'devbox',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: '',
          },
          terminals: [createTerminal({ status: 'running', agentActive: true })],
        }),
      ]);

      renderStatusBar();

      expect(
        screen.getByRole('button', {
          name: 'Keeping this computer awake while 1 agent works on it',
        })
      ).toHaveTextContent('Awake');
    });

    it('waits for an agent in agents mode', () => {
      mockState.config = { keepAwakeMode: 'agents', statusBarShownItems: ['keep-awake'] };

      renderStatusBar();

      expect(
        screen.getByRole('button', { name: 'Keeps this computer awake while agents work on it' })
      ).not.toHaveTextContent('Awake');
    });

    it('changes the mode from its menu', async () => {
      const user = userEvent.setup();
      renderStatusBar();

      await user.click(screen.getByRole('button', { name: 'Keep awake is off' }));
      const always = screen.getByRole('menuitemradio', { name: 'Always' });
      expect(always).toHaveAccessibleDescription('Stay awake until you turn this off');
      await user.click(always);

      expect(mockState.updateConfig).toHaveBeenCalledWith({ keepAwakeMode: 'always' });
    });
  });

  describe('agent usage limits', () => {
    const NOW = Date.parse('2026-10-23T12:00:00Z');

    function window(
      name: string,
      short: string | null,
      usedPercent: number,
      resetsAt = null as number | null
    ) {
      return { name, short, usedPercent, resetsAt };
    }

    function reading(overrides: Partial<AgentUsageReading> = {}): AgentUsageReading {
      return {
        source: 'claude-code',
        windows: [
          window('5-hour limit', '5h', 3, NOW + 90 * 60_000),
          window('Weekly limit', '7d', 47, NOW + 4 * 86_400_000),
          window('Weekly Fable limit', null, 0),
        ],
        plan: 'max',
        account: 'dev@example.com',
        readAt: NOW - 2 * 60_000,
        problem: null,
        ...overrides,
      };
    }

    function mockUsage(usage: AgentUsage, overrides: Record<string, unknown> = {}) {
      const refreshAgentUsage = vi.fn(() => Promise.resolve(usage));
      mockApi({
        getAgentUsage: vi.fn(() => Promise.resolve({})),
        refreshAgentUsage,
        onAgentUsageChange: vi.fn(() => () => {}),
        ...overrides,
      });
      return refreshAgentUsage;
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
      onTestFinished(() => vi.useRealTimers());
    });

    it('stays off until turned on, and reads no usage while off', () => {
      mockState.config = {};
      const refreshAgentUsage = mockUsage({});

      renderStatusBar();

      expect(refreshAgentUsage).not.toHaveBeenCalled();
    });

    it('reads only the agent whose item is on', async () => {
      mockState.config = { statusBarShownItems: ['codex-usage'] };
      const refreshAgentUsage = mockUsage({ codex: reading({ source: 'codex', plan: 'plus' }) });

      renderStatusBar();

      expect(await screen.findByRole('button', { name: /^Codex usage/ })).toBeInTheDocument();
      expect(refreshAgentUsage).toHaveBeenCalledWith({ sources: ['codex'] });
      expect(refreshAgentUsage).not.toHaveBeenCalledWith({ sources: ['claude-code'] });
    });

    it('shows the weekly limit, and lists every limit in its popover', async () => {
      mockState.config = { statusBarShownItems: ['claude-code-usage'] };
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const refreshAgentUsage = mockUsage({ 'claude-code': reading() });

      renderStatusBar();

      const button = await screen.findByRole('button', {
        name: 'Claude Code usage: 47% of the weekly limit, resets in 4d 0h',
      });
      expect(button).toHaveTextContent(/^47%4d 0h$/);

      await user.click(button);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Max plan · dev@example.com')).toBeInTheDocument();
      expect(within(dialog).getByText('Weekly limit')).toBeInTheDocument();
      expect(within(dialog).getByText('Weekly Fable limit')).toBeInTheDocument();
      expect(within(dialog).getByText('Resets in 1h 30m')).toBeInTheDocument();
      expect(within(dialog).getByText('Updated 2m ago')).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Refresh' }));
      expect(refreshAgentUsage).toHaveBeenLastCalledWith({ sources: ['claude-code'], force: true });
    });

    it.each([
      ['the five-hour limit reaches 85%', 85, 47, undefined, '85% 5h·47% 7d'],
      ['the five-hour limit is below 85%', 84, 91.4, undefined, '91% 7d'],
      ['the user picked the weekly limit', 95, 47, 'weekly', '47% 7d'],
      ['the user picked both', 3, 47, 'both', '3% 5h·47% 7d'],
      ['the user picked the five-hour limit', 3, 95, 'five-hour', '3% 5h'],
    ])('shows the right limits when %s', async (_, session, weekly, limits, text) => {
      mockState.config = {
        statusBarShownItems: ['claude-code-usage'],
        statusBarUsageLimits: limits,
      };
      mockUsage({
        'claude-code': reading({
          windows: [window('5-hour limit', '5h', session), window('Weekly limit', '7d', weekly)],
        }),
      });

      renderStatusBar();

      expect(await screen.findByRole('button', { name: /^Claude Code usage/ })).toHaveTextContent(
        new RegExp(`^${text}$`)
      );
    });

    it('shows the one limit of a plan with one, whichever the user picked', async () => {
      mockState.config = { statusBarShownItems: ['codex-usage'], statusBarUsageLimits: 'weekly' };
      mockUsage({
        codex: reading({ source: 'codex', windows: [window('30-day limit', '30d', 100)] }),
      });

      renderStatusBar();

      expect(await screen.findByRole('button', { name: /^Codex usage/ })).toHaveTextContent(
        /^100% 30d$/
      );
    });

    it('names each limit with its time until reset when the bar shows two', async () => {
      mockState.config = {
        statusBarShownItems: ['claude-code-usage'],
        statusBarUsageLimits: 'both',
      };
      mockUsage({ 'claude-code': reading() });

      renderStatusBar();

      expect(
        await screen.findByRole('button', {
          name:
            'Claude Code usage: 3% of the 5-hour limit, resets in 1h 30m; ' +
            '47% of the weekly limit, resets in 4d 0h',
        })
      ).toHaveTextContent(/^3%1h 30m·47%4d 0h$/);
    });

    it('leaves out the time until reset when the user turned it off', async () => {
      mockState.config = {
        statusBarShownItems: ['claude-code-usage'],
        statusBarUsageResetTime: false,
      };
      mockUsage({ 'claude-code': reading() });

      renderStatusBar();

      expect(
        await screen.findByRole('button', { name: 'Claude Code usage: 47% of the weekly limit' })
      ).toHaveTextContent(/^47% 7d$/);
    });

    it('leaves out the time until reset once the limit has reset', async () => {
      mockState.config = { statusBarShownItems: ['claude-code-usage'] };
      mockUsage({
        'claude-code': reading({ windows: [window('Weekly limit', '7d', 47, NOW - 60_000)] }),
      });

      renderStatusBar();

      expect(
        await screen.findByRole('button', { name: 'Claude Code usage: 0% of the weekly limit' })
      ).toHaveTextContent(/^0% 7d$/);
    });

    it('turns the time until reset off from the popover', async () => {
      mockState.config = { statusBarShownItems: ['claude-code-usage'] };
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mockUsage({ 'claude-code': reading() });

      renderStatusBar();
      await user.click(await screen.findByRole('button', { name: /^Claude Code usage/ }));
      const toggle = screen.getByRole('switch', { name: 'Time until reset' });
      expect(toggle).toBeChecked();
      await user.click(toggle);

      expect(mockState.updateConfig).toHaveBeenCalledWith({ statusBarUsageResetTime: false });
    });

    it('picks which limits the bar shows from the popover', async () => {
      mockState.config = { statusBarShownItems: ['claude-code-usage'] };
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mockUsage({ 'claude-code': reading() });

      renderStatusBar();
      await user.click(await screen.findByRole('button', { name: /^Claude Code usage/ }));
      await user.click(screen.getByRole('button', { name: 'Status bar shows: Auto' }));
      expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveAccessibleDescription(
        'Weekly, and 5-hour once it reaches 85%'
      );
      const weekly = screen.getByRole('menuitemradio', { name: 'Weekly limit' });
      await user.click(weekly);

      expect(mockState.updateConfig).toHaveBeenCalledWith({ statusBarUsageLimits: 'weekly' });
    });

    it('reads again every five minutes and takes what the main process sends', async () => {
      mockState.config = { statusBarShownItems: ['codex-usage'] };
      let send: (usage: AgentUsage) => void = () => {};
      const refreshAgentUsage = mockUsage(
        {},
        {
          onAgentUsageChange: vi.fn((callback: typeof send) => {
            send = callback;
            return () => {};
          }),
        }
      );

      renderStatusBar();
      expect(refreshAgentUsage).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(5 * 60_000));
      expect(refreshAgentUsage).toHaveBeenCalledTimes(2);

      act(() => send({ codex: reading({ source: 'codex', plan: 'plus' }) }));
      expect(screen.getByRole('button', { name: /^Codex usage/ })).toBeInTheDocument();
    });

    it.each([
      ['expired', "Claude Code's sign-in has expired. It renews when you next run Claude Code."],
      ['signed-out', 'Sign in to Claude Code with a plan on this computer to see its usage.'],
    ] as const)('dims the item and says why when %s', async (problem, message) => {
      mockState.config = { statusBarShownItems: ['claude-code-usage'] };
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mockUsage(
        {},
        {
          getAgentUsage: vi.fn(() =>
            Promise.resolve({
              'claude-code': reading(
                problem === 'signed-out' ? { windows: [], problem } : { problem }
              ),
            })
          ),
          refreshAgentUsage: vi.fn(() => new Promise(() => {})),
        }
      );

      renderStatusBar();

      const button = await screen.findByRole('button', { name: /^Claude Code usage/ });
      expect(button).toHaveClass('opacity-60');
      await user.click(button);
      expect(within(screen.getByRole('dialog')).getByText(message)).toBeInTheDocument();
    });
  });

  describe('notification sounds', () => {
    it('mutes sounds, keeping the chosen sounds', async () => {
      const user = userEvent.setup();
      const sounds = { ...DEFAULT_NOTIFICATION_SOUNDS, volume: 0.8, turnCompleteSound: 'glass' };
      mockState.config = { notificationSounds: sounds };
      renderStatusBar();

      const toggle = screen.getByRole('button', { name: 'Notification sounds' });
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await user.click(toggle);

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        notificationSounds: { ...sounds, enabled: false },
      });
    });

    it('turns muted sounds back on', async () => {
      const user = userEvent.setup();
      mockState.config = {
        notificationSounds: { ...DEFAULT_NOTIFICATION_SOUNDS, enabled: false },
      };
      renderStatusBar();

      const toggle = screen.getByRole('button', { name: 'Notification sounds' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await user.click(toggle);

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        notificationSounds: DEFAULT_NOTIFICATION_SOUNDS,
      });
    });

    it('shows by default, until hidden from the bar', () => {
      const { unmount } = renderStatusBar();
      expect(screen.getByRole('button', { name: 'Notification sounds' })).toBeInTheDocument();
      unmount();

      mockState.config = { statusBarHiddenItems: ['notification-sounds'] };
      renderStatusBar();
      expect(screen.queryByRole('button', { name: 'Notification sounds' })).not.toBeInTheDocument();
    });

    it('stays while the hooks endpoint is off, as agents that report their own status still play sounds', () => {
      mockState.config = { disableNotificationEndpoint: true };

      renderStatusBar();

      expect(screen.getByRole('button', { name: 'Notification sounds' })).toBeInTheDocument();
    });

    it('hides while the hooks endpoint is off on Windows, as no sound can play', () => {
      (window as any).api.platform = 'win32';
      mockState.config = { disableNotificationEndpoint: true };

      renderStatusBar();

      expect(screen.queryByRole('button', { name: 'Notification sounds' })).not.toBeInTheDocument();
    });
  });

  describe('notes', () => {
    beforeEach(() => {
      mockState.config = { statusBarShownItems: ['notes'] };
    });

    function openWorkspace() {
      const workspace = createWorkspace({
        windowId: WINDOW_ID,
        name: 'login-fix',
        projectId: 'p1',
      });
      setWorkspaces([workspace]);
      useWorkspacesStore.setState({ selectedWorkspaceId: workspace.id });
      return workspace;
    }

    it('shows only while a workspace is open', () => {
      renderStatusBar();
      expect(screen.queryByRole('button', { name: /^Notes/ })).not.toBeInTheDocument();
    });

    it("lists the workspace's notes, opens one, and starts a new one", async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace();
      const listNotes = vi.fn(() =>
        Promise.resolve([
          { name: 'b.md', title: 'Prompt for the login fix', path: '/n/b.md', modifiedMs: 2 },
          { name: 'a.md', title: '', path: '/n/a.md', modifiedMs: 1 },
        ])
      );
      mockApi({ listNotes });

      renderStatusBar();
      await user.click(await screen.findByRole('button', { name: 'Notes, 2 notes' }));

      expect(listNotes).toHaveBeenCalledWith(workspace.id);
      expect(screen.getByText('Notes in login-fix')).toBeInTheDocument();
      const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
      expect(items[0]).toBe('New note');
      expect(items[1]).toContain('Prompt for the login fix');
      expect(items[2]).toContain('Untitled note');

      await user.click(screen.getByRole('menuitem', { name: /Prompt for the login fix/ }));
      expect(notesMocks.openNote).toHaveBeenCalledWith(workspace.id, 'b.md');

      await user.click(screen.getByRole('button', { name: 'Notes, 2 notes' }));
      await user.click(screen.getByRole('menuitem', { name: 'New note' }));
      expect(notesMocks.createNote).toHaveBeenCalledWith(workspace.id);
    });

    it('says what notes are before there is one', async () => {
      const user = userEvent.setup();
      openWorkspace();

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Notes' }));

      expect(screen.getByRole('menu')).toHaveTextContent('kept outside the repository');
    });

    it('starts hidden', () => {
      mockState.config = {};
      openWorkspace();

      renderStatusBar();

      expect(screen.queryByRole('button', { name: /^Notes/ })).not.toBeInTheDocument();
    });
  });

  describe('commit graph', () => {
    const FIX = 'f'.repeat(40);
    const INITIAL = 'a'.repeat(40);
    const GRAPH: CommitGraph = {
      commits: [
        {
          hash: FIX,
          parentHashes: [INITIAL],
          author: 'Ada',
          timestamp: 1_700_000_100,
          message: 'Fix the login redirect\n\nIt looped.',
          refs: [{ kind: 'branch', name: 'login-fix' }],
        },
        {
          hash: INITIAL,
          parentHashes: [],
          author: 'Bob',
          timestamp: 1_700_000_000,
          message: 'Initial commit',
          refs: [
            { kind: 'tag', name: 'v1.0' },
            { kind: 'remote', name: 'origin/main' },
            { kind: 'branch', name: 'other' },
            { kind: 'branch', name: 'main' },
          ],
        },
      ],
      hasMore: true,
      currentBranch: 'login-fix',
      upstream: null,
    };

    function openWorkspace(overrides: Parameters<typeof createWorkspace>[0] = {}) {
      const workspace = createWorkspace({ windowId: WINDOW_ID, name: 'login-fix', ...overrides });
      setWorkspaces([workspace]);
      useWorkspacesStore.setState({ selectedWorkspaceId: workspace.id });
      return workspace;
    }

    beforeEach(() => {
      mockState.config = { statusBarShownItems: ['commit-graph'] };
      useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
      useWorkspaceObservationStore.setState({ projections: new Map() });
    });

    it("lists HEAD's commits with their branches and opens one in History", async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace();
      const getWorkspaceCommitGraph = vi.fn(() => Promise.resolve(GRAPH));
      mockApi({ getWorkspaceCommitGraph });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));

      const fix = await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      expect(getWorkspaceCommitGraph).toHaveBeenCalledWith(workspace.id, { limit: 100 });
      expect(screen.getByText('Commits on login-fix')).toBeInTheDocument();
      expect(within(fix).getByText('login-fix')).toBeInTheDocument();
      // The target branch first; origin/main only repeats main; one more ref than fits.
      const initial = screen.getByRole('menuitem', { name: /Initial commit/ });
      expect(
        within(initial)
          .getAllByText(/^(main|other|origin\/main|v1\.0|\+\d)$/)
          .map((pill) => pill.textContent)
      ).toEqual(['main', 'other', '+1']);

      await user.click(initial);

      const fileViewer = useFileViewerStore.getState();
      expect(fileViewer.fileViewerWorkspaceId).toBe(workspace.id);
      expect(fileViewer.fileViewerDiffSubMode).toBe('history');
      expect(fileViewer.pendingFileViewerTransition).toMatchObject({
        after: { kind: 'commit', commitHash: INITIAL },
      });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      // Focus is left to the viewer, not handed back to the button behind it.
      expect(screen.getByRole('button', { name: 'Commit graph' })).not.toHaveFocus();
    });

    it('gives focus back to its button when closed with Escape', async () => {
      const user = userEvent.setup();
      openWorkspace();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)) });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      await user.keyboard('{Escape}');

      expect(screen.getByRole('button', { name: 'Commit graph' })).toHaveFocus();
    });

    it("shows a commit's title, body and details only once the pointer rests on it", async () => {
      const user = userEvent.setup();
      openWorkspace();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)) });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const fix = await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });

      // Moving across the row shows nothing yet.
      fireEvent.pointerMove(fix);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      fireEvent.pointerMove(fix);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(100);
      });
      const details = screen.getByRole('tooltip');
      expect(within(details).getByText('Fix the login redirect')).toBeInTheDocument();
      expect(within(details).getByText('It looped.')).toBeInTheDocument();
      expect(details).toHaveTextContent('Ada');
      expect(details).toHaveTextContent('fffffff');

      // Leaving the row away from them hides them.
      fireEvent.pointerLeave(fix, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document.body, { clientX: 10, clientY: 400 });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      // Scrolling the list puts another commit under the pointer.
      fireEvent.pointerMove(fix);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      fireEvent.scroll(fix.parentElement!);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it("keeps a commit's details open while the pointer heads onto them, to copy from", async () => {
      const user = userEvent.setup();
      openWorkspace();
      const copyToClipboard = vi.fn();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)), copyToClipboard });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const fix = await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      fireEvent.pointerMove(fix);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const details = screen.getByRole('tooltip');
      // The row in the menu, and its details beside the menu.
      vi.spyOn(fix, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 24));
      vi.spyOn(details, 'getBoundingClientRect').mockReturnValue(new DOMRect(410, 100, 350, 160));

      // Crossing the gap, and rows below on the way, keeps them.
      fireEvent.pointerLeave(fix, { clientX: 400, clientY: 112 });
      fireEvent.pointerMove(document.body, { clientX: 405, clientY: 130 });
      fireEvent.pointerMove(details, { clientX: 420, clientY: 150 });
      expect(screen.getByRole('tooltip')).toBe(details);

      fireEvent.click(within(details).getByRole('button', { name: `Copy commit hash ${FIX}` }));
      expect(copyToClipboard).toHaveBeenCalledWith(FIX);
      expect(screen.getByRole('tooltip')).toBe(details);
      expect(screen.getByRole('menu')).toBeInTheDocument();

      // Back to the row keeps them; on to another commit hides them.
      fireEvent.pointerLeave(details, { clientX: 410, clientY: 250 });
      fireEvent.pointerMove(document.body, { clientX: 380, clientY: 180 });
      fireEvent.pointerMove(fix, { clientX: 370, clientY: 120 });
      expect(screen.getByRole('tooltip')).toBe(details);
      fireEvent.pointerLeave(fix, { clientX: 200, clientY: 124 });
      fireEvent.pointerMove(document.body, { clientX: 200, clientY: 140 });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it("keeps another commit's details reachable once the last one's have faded out", async () => {
      const user = userEvent.setup();
      openWorkspace();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)) });
      // Details fade out on closing, as they do in the app; jsdom runs no animations.
      const computedStyle = window.getComputedStyle;
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = computedStyle(element, pseudo);
        if (!element.matches('[data-native-overlay="tooltip"]')) return style;
        return new Proxy(style, {
          get: (target, key) => {
            if (key === 'animationName') {
              return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
            }
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const fix = await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      const initial = screen.getByRole('menuitem', { name: /Initial commit/ });
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      fireEvent.pointerMove(fix);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const fading = screen.getByRole('tooltip');
      fireEvent.pointerMove(initial);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      act(() => {
        fading.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'exit' }));
      });
      const details = screen.getByRole('tooltip');
      expect(details).toHaveTextContent('Initial commit');
      vi.spyOn(initial, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 124, 400, 24));
      vi.spyOn(details, 'getBoundingClientRect').mockReturnValue(new DOMRect(410, 124, 350, 160));

      fireEvent.pointerLeave(initial, { clientX: 400, clientY: 136 });
      fireEvent.pointerMove(document.body, { clientX: 405, clientY: 150 });
      // Not fading out in turn.
      expect(details).not.toHaveAttribute('data-state', 'closed');
    });

    it("copies a commit's hash from its right-click menu, staying open", async () => {
      const user = userEvent.setup();
      openWorkspace();
      const copyToClipboard = vi.fn();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)), copyToClipboard });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const initial = await screen.findByRole('menuitem', { name: /Initial commit/ });
      await user.pointer({ keys: '[MouseRight]', target: initial });
      await user.click(await screen.findByRole('menuitem', { name: 'Copy Commit Hash' }));

      expect(copyToClipboard).toHaveBeenCalledWith(INITIAL);
      expect(useToastStore.getState().toasts[0].message).toBe('Copied commit aaaaaaa');
      expect(screen.getByRole('menuitem', { name: /Initial commit/ })).toBeInTheDocument();
      expect(useFileViewerStore.getState().pendingFileViewerTransition).toBeNull();
    });

    it('adds older commits on request, staying open', async () => {
      const user = userEvent.setup();
      openWorkspace();
      const getWorkspaceCommitGraph = vi.fn(() => Promise.resolve(GRAPH));
      mockApi({ getWorkspaceCommitGraph });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Show older commits' }));

      expect(getWorkspaceCommitGraph).toHaveBeenLastCalledWith(expect.any(String), { limit: 200 });
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('reads the commits again when the repository changes while it is open', async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace();
      const getWorkspaceCommitGraph = vi.fn(() => Promise.resolve(GRAPH));
      mockApi({ getWorkspaceCommitGraph });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      act(() =>
        useWorkspaceObservationStore.getState().applyProjection({
          workspaceId: workspace.id,
          revision: 2,
          repositoryRevision: 2,
        } as WorkspaceObservationProjection)
      );

      expect(getWorkspaceCommitGraph).toHaveBeenCalledTimes(2);
    });

    it("says why when the commits can't be read", async () => {
      const user = userEvent.setup();
      openWorkspace();
      mockApi({
        getWorkspaceCommitGraph: vi.fn(() => Promise.reject(new Error('fatal: bad object'))),
      });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));

      expect(await screen.findByText("Couldn't read the commits: fatal: bad object")).toBeVisible();
    });

    it('opens commits of an SSH workspace in History too, and copies a hash with Ctrl+C', async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace({
        backend: { kind: 'ssh' } as ReturnType<typeof createWorkspace>['backend'],
      });
      const getWorkspaceCommitGraph = vi.fn(() => Promise.resolve(GRAPH));
      const copyToClipboard = vi.fn();
      mockApi({ getWorkspaceCommitGraph, copyToClipboard });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const initial = await screen.findByRole('menuitem', { name: /Initial commit/ });
      act(() => initial.focus());
      await user.keyboard('{Control>}c{/Control}');

      expect(getWorkspaceCommitGraph).toHaveBeenCalledWith(workspace.id, { limit: 100 });
      expect(copyToClipboard).toHaveBeenCalledWith(INITIAL);
      expect(useToastStore.getState().toasts[0].message).toBe('Copied commit aaaaaaa');
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.click(initial);
      expect(useFileViewerStore.getState()).toMatchObject({
        fileViewerWorkspaceId: workspace.id,
        fileViewerDiffSubMode: 'history',
        pendingFileViewerTransition: { after: { kind: 'commit', commitHash: INITIAL } },
      });
    });

    it('copies a hash with Caps Lock on or on a keyboard without Latin letters', async () => {
      const user = userEvent.setup();
      openWorkspace();
      const copyToClipboard = vi.fn();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)), copyToClipboard });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      const initial = await screen.findByRole('menuitem', { name: /Initial commit/ });
      act(() => initial.focus());
      fireEvent.keyDown(initial, { key: 'C', code: 'KeyC', ctrlKey: true });
      fireEvent.keyDown(initial, { key: 'с', code: 'KeyC', ctrlKey: true });
      // Dvorak puts J where QWERTY has C.
      fireEvent.keyDown(initial, { key: 'j', code: 'KeyC', ctrlKey: true });

      expect(copyToClipboard).toHaveBeenCalledTimes(2);
      expect(copyToClipboard).toHaveBeenCalledWith(INITIAL);
    });

    it('opens History from the top of the list', async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace();
      mockApi({ getWorkspaceCommitGraph: vi.fn(() => Promise.resolve(GRAPH)) });

      renderStatusBar();
      await user.click(screen.getByRole('button', { name: 'Commit graph' }));
      await screen.findByRole('menuitem', { name: /Fix the login redirect/ });
      const [first] = screen.getAllByRole('menuitem');
      expect(first).toHaveTextContent('Open history');
      await user.click(first);

      expect(useFileViewerStore.getState()).toMatchObject({
        fileViewerWorkspaceId: workspace.id,
        fileViewerDiffSubMode: 'history',
      });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('shows only for git workspaces, unless turned off', () => {
      openWorkspace({ isWorktree: false });
      const { rerender } = renderStatusBar();
      expect(screen.queryByRole('button', { name: 'Commit graph' })).not.toBeInTheDocument();

      mockState.config = { statusBarHiddenItems: ['commit-graph'] };
      openWorkspace();
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      expect(screen.queryByRole('button', { name: 'Commit graph' })).not.toBeInTheDocument();
    });
  });

  describe('custom items', () => {
    it("shows the open workspace's agent items and follows their changes", async () => {
      let onChange: ((items: AgentStatusItem[]) => void) | undefined;
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([item(), item({ id: 'other', workspaceId: 'ws-other', text: 'Hidden' })])
        ),
        onStatusItemsChange: vi.fn((callback: (items: AgentStatusItem[]) => void) => {
          onChange = callback;
          return () => {};
        }),
      });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      expect(await screen.findByRole('button', { name: '142/150 passing' })).toBeInTheDocument();
      expect(screen.queryByText('Hidden')).not.toBeInTheDocument();

      act(() => onChange?.([item({ text: 'All passing', tone: 'success' })]));
      expect(screen.getByRole('button', { name: 'All passing' })).toBeInTheDocument();
      act(() => onChange?.([]));
      expect(screen.queryByRole('button', { name: 'All passing' })).not.toBeInTheDocument();
    });

    it('shows the colors an item asks for, following the theme', async () => {
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({ id: 'a', text: 'Theme', color: 'warning' }),
            item({ id: 'b', text: 'Hex', color: '#e5c07b' }),
          ])
        ),
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand: vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: {
              text: '\uf00c CI on main',
              segments: [
                { text: '\uf00c CI', color: 'success', bold: true },
                { text: ' on ' },
                { text: 'main', color: '#ff8700' },
              ],
            },
            ranAt: 1,
          })
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      const ci = await screen.findByRole('button', { name: '\uf00c CI on main' });
      expect(within(ci).getByText('\uf00c CI')).toHaveClass('text-success', 'font-semibold');
      expect(within(ci).getByText('main')).toHaveStyle({ color: '#ff8700' });
      expect(screen.getByText('Theme')).toHaveClass('text-warning', 'font-status');
      expect(screen.getByText('Hex')).toHaveStyle({ color: '#e5c07b' });
    });

    it('shows icons where an item puts them, in a color when it names one', async () => {
      const png = 'data:image/png;base64,iVBORw0KGgo=';
      const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({
              id: 'deploy',
              text: 'live',
              segments: [
                { icon: png },
                { text: ' live ' },
                { icon: svg, color: 'success' },
                { icon: 'https://example.com/a.svg' },
              ],
            }),
          ])
        ),
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'logo', label: 'Acme', intervalSeconds: 60 }] })
        ),
        runStatusCommand: vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: { text: '', segments: [{ icon: png }] },
            ranAt: 1,
          })
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      const deploy = await screen.findByRole('button', { name: 'live' });
      const parts = [...deploy.querySelectorAll('.font-status > *')];
      expect(parts).toHaveLength(3);
      expect(parts[0]).toHaveAttribute('src', png);
      expect(parts[1]).toHaveTextContent('live');
      expect(parts[2]).toHaveClass('text-success', 'bg-current');
      expect((parts[2] as HTMLElement).style.mask).toContain(svg);
      // An item that shows only an icon reads as its label.
      const logo = await screen.findByRole('button', { name: 'Acme' });
      expect(logo.querySelector('img')).toHaveAttribute('src', png);
    });

    it("opens an agent item's Markdown in a popover, with its link as a button", async () => {
      const user = userEvent.setup();
      const openExternal = vi.fn(() => Promise.resolve());
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({
              id: 'pr',
              text: 'PR #812',
              link: 'https://github.com/o/r/pull/812',
              popover:
                '## Review\nRequested from **you** <img src=x onerror="alert(1)"><script>alert(2)</script><span class="fixed inset-0">cover</span>',
            }),
          ])
        ),
        openExternal,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: 'Review' })).toBeInTheDocument();
      expect(dialog.querySelector('script, [onerror], .fixed')).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'Open github.com' }));
      expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/812');
    });

    describe('with a popover command', () => {
      const popoverApi = (overrides: Record<string, unknown> = {}) => {
        const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: 'PR #812' }, ranAt: 1 })
        );
        const runStatusPopover = vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: {
              markdown: '**Checks**: e2e failed',
              buttons: [
                { label: 'Open PR', link: 'https://github.com/o/r/pull/812' },
                { label: 'Run tests', action: 'Tests' },
                { label: 'Rerun', run: 'rerun' },
              ],
            },
          })
        );
        const runStatusButton = vi.fn(() => Promise.resolve({}));
        mockApi({
          listStatusCommands: vi.fn(() =>
            Promise.resolve({ items: [{ id: 'pr', intervalSeconds: 60, popover: true }] })
          ),
          runStatusCommand,
          runStatusPopover,
          runStatusButton,
          ...overrides,
        });
        useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
        return { runStatusCommand, runStatusPopover, runStatusButton };
      };

      it('runs it on click and shows its Markdown and buttons', async () => {
        const user = userEvent.setup();
        const { runStatusPopover } = popoverApi();
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByText('Checks')).toBeInTheDocument();
        expect(runStatusPopover).toHaveBeenCalledWith('ws-open', 'pr', expect.any(Object));
        expect(
          within(dialog)
            .getAllByRole('button')
            .map((button) => button.textContent)
        ).toEqual(['', 'Open PR', 'Run tests', 'Rerun']);
        expect(within(dialog).getByRole('button', { name: 'Run tests' })).toHaveAttribute(
          'title',
          'Runs the quick command “Tests”'
        );
        expect(within(dialog).getByRole('button', { name: 'Rerun' })).toHaveAttribute(
          'title',
          'Runs “rerun” from status-items.json'
        );
      });

      it("runs a button's command, then shows the item and popover again", async () => {
        const user = userEvent.setup();
        const { runStatusCommand, runStatusPopover, runStatusButton } = popoverApi();
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(await within(dialog).findByRole('button', { name: 'Rerun' }));

        expect(runStatusButton).toHaveBeenCalledWith('ws-open', 'pr', 'rerun');
        await vi.waitFor(() => expect(runStatusPopover).toHaveBeenCalledTimes(2));
        expect(runStatusCommand).toHaveBeenCalledTimes(2);
      });

      it("doesn't run the popover command again once it closed before a button's command ended", async () => {
        const user = userEvent.setup();
        let finish: (result: object) => void = () => {};
        const { runStatusCommand, runStatusPopover } = popoverApi({
          runStatusButton: vi.fn(() => new Promise((resolve) => (finish = resolve))),
        });
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        await user.click(await screen.findByRole('button', { name: 'Rerun' }));
        await user.keyboard('{Escape}');
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        finish({});

        await vi.waitFor(() => expect(runStatusCommand).toHaveBeenCalledTimes(2));
        expect(runStatusPopover).toHaveBeenCalledOnce();
      });

      it("says why a button's command failed", async () => {
        const user = userEvent.setup();
        popoverApi({
          runStatusButton: vi.fn(() => Promise.resolve({ error: 'gh: not logged in' })),
        });
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        await user.click(await screen.findByRole('button', { name: 'Rerun' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Rerun failed: gh: not logged in'
        );
      });

      it("runs the project's Action a button names", async () => {
        const user = userEvent.setup();
        popoverApi();
        const tests = { id: 'a-1', title: 'Tests', content: 'npm test', type: 'command' as const };
        useActionsStore.setState({ actions: [tests] });
        actionMocks.runAction.mockReset();
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        await user.click(await screen.findByRole('button', { name: 'Run tests' }));

        await vi.waitFor(() => expect(actionMocks.runAction).toHaveBeenCalledWith(tests));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      it('shows HTML in a sandboxed frame that grows to the height it reports', async () => {
        const user = userEvent.setup();
        const runStatusPopover = vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: { markdown: '', htmlUrl: 'komla-preview://token/popover.html', buttons: [] },
          })
        );
        popoverApi({ runStatusPopover });
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        const frame = (await screen.findByTitle('pr')) as HTMLIFrameElement;
        expect(frame).toHaveAttribute('src', 'komla-preview://token/popover.html');
        expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
        expect(runStatusPopover).toHaveBeenCalledWith('ws-open', 'pr', {
          scheme: expect.stringMatching(/^(light|dark)$/),
          colors: expect.any(Object),
        });

        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', { data: { komlaPopoverHeight: 9000 }, source: window })
          );
        });
        expect(frame.style.height).toBe('80px');
        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverHeight: 212.4 },
              source: frame.contentWindow,
            })
          );
        });
        expect(frame.style.height).toBe('213px');
        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverHeight: 9000 },
              source: frame.contentWindow,
            })
          );
        });
        expect(frame.style.height).toBe('420px');

        // Escape pressed in the page closes the popover.
        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverClose: true },
              source: frame.contentWindow,
            })
          );
        });
        await vi.waitFor(() => expect(screen.queryByTitle('pr')).not.toBeInTheDocument());
      });

      it('shows the last popover at once when it opens again, while it runs again', async () => {
        const user = userEvent.setup();
        const { runStatusPopover } = popoverApi();
        renderStatusBar();

        const trigger = await screen.findByRole('button', { name: 'PR #812, shows details' });
        await user.click(trigger);
        expect(await screen.findByText('Checks')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        runStatusPopover.mockImplementationOnce(() => new Promise(() => {}));
        await user.click(trigger);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Checks')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Refresh' })).toBeDisabled();
        // What they do may no longer fit what the popover shows.
        expect(within(dialog).getByRole('button', { name: 'Rerun' })).toBeDisabled();
        expect(within(dialog).getByRole('button', { name: 'Open PR' })).toBeDisabled();
        expect(runStatusPopover).toHaveBeenCalledTimes(2);
      });

      it("doesn't show the last HTML page again once the theme changed", async () => {
        const user = userEvent.setup();
        const runStatusPopover = vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: { markdown: '', htmlUrl: 'komla-preview://t1/popover.html', buttons: [] },
          })
        );
        popoverApi({ runStatusPopover });
        onTestFinished(() => document.documentElement.classList.remove('dark'));
        renderStatusBar();

        const trigger = await screen.findByRole('button', { name: 'PR #812, shows details' });
        await user.click(trigger);
        expect(await screen.findByTitle('pr')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        document.documentElement.classList.add('dark');
        runStatusPopover.mockImplementationOnce(() => new Promise(() => {}));
        await user.click(trigger);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Loading…')).toBeInTheDocument();
        expect(within(dialog).queryByTitle('pr')).not.toBeInTheDocument();
        expect(runStatusPopover).toHaveBeenLastCalledWith(
          'ws-open',
          'pr',
          expect.objectContaining({ scheme: 'dark' })
        );
      });

      it('keeps an HTML page on screen, at its height, until the next one loads', async () => {
        const user = userEvent.setup();
        let page = 0;
        const runStatusPopover = vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({
            id,
            workspaceId,
            content: {
              markdown: '',
              htmlUrl: `komla-preview://t${++page}/popover.html`,
              buttons: [],
            },
          })
        );
        popoverApi({ runStatusPopover });
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        const first = (await screen.findByTitle('pr')) as HTMLIFrameElement;
        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverHeight: 150 },
              source: first.contentWindow,
            })
          );
        });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        const dialog = screen.getByRole('dialog');
        await vi.waitFor(() => expect(dialog.querySelectorAll('iframe')).toHaveLength(2));
        const [shown, next] = [...dialog.querySelectorAll('iframe')];
        expect(shown).toBe(first);
        expect(shown).not.toHaveClass('invisible');
        expect(next).toHaveAttribute('src', 'komla-preview://t2/popover.html');
        expect(next).toHaveClass('invisible');

        // Loading isn't enough, as an error page loads too, and the page behind can't close it.
        fireEvent.load(next);
        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverClose: true },
              source: next.contentWindow,
            })
          );
        });
        expect(dialog.querySelectorAll('iframe')).toHaveLength(2);
        expect(next).toHaveClass('invisible');

        act(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { komlaPopoverHeight: 180 },
              source: next.contentWindow,
            })
          );
        });
        expect(dialog.querySelectorAll('iframe')).toHaveLength(1);
        expect(dialog.querySelector('iframe')).toBe(next);
        expect(next).not.toHaveClass('invisible');
        expect(next.style.height).toBe('180px');

        // Opened again, the page starts at the height it last had.
        await user.keyboard('{Escape}');
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: 'PR #812, shows details' }));
        const [reopened] = await screen.findAllByTitle('pr');
        expect(reopened).toHaveAttribute('src', 'komla-preview://t2/popover.html');
        expect(reopened.style.height).toBe('180px');
      });

      it('opens on the page of a run that ended after it closed', async () => {
        const user = userEvent.setup();
        let page = 0;
        const finishes: Array<() => void> = [];
        const runStatusPopover = vi.fn(
          (workspaceId: string, id: string) =>
            new Promise((resolve) => {
              const htmlUrl = `komla-preview://t${++page}/popover.html`;
              const finish = () =>
                resolve({ id, workspaceId, content: { markdown: '', htmlUrl, buttons: [] } });
              if (page === 1) finish();
              else finishes.push(finish);
            })
        );
        popoverApi({ runStatusPopover });
        renderStatusBar();

        const trigger = await screen.findByRole('button', { name: 'PR #812, shows details' });
        for (let opened = 0; opened < 3; opened++) {
          await user.click(trigger);
          await screen.findAllByTitle('pr');
          await user.keyboard('{Escape}');
          await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        }
        // Ended in the order they started, so the main process now serves pages 2 and 3 only.
        await act(async () => finishes.forEach((finish) => finish()));

        await user.click(trigger);
        const [reopened] = await screen.findAllByTitle('pr');
        expect(reopened).toHaveAttribute('src', 'komla-preview://t3/popover.html');
      });

      it('says what failed when the popover command fails', async () => {
        const user = userEvent.setup();
        popoverApi({
          runStatusPopover: vi.fn((workspaceId: string, id: string) =>
            Promise.resolve({ id, workspaceId, content: null, error: 'exit 1' })
          ),
        });
        renderStatusBar();

        await user.click(await screen.findByRole('button', { name: 'PR #812, shows details' }));
        expect(await screen.findByText('The popover command failed: exit 1')).toBeInTheDocument();
      });
    });

    it('runs the Action an item names when clicked, or says it is missing', async () => {
      const user = userEvent.setup();
      mockApi({
        listActions: vi.fn(() => Promise.resolve([])),
        listStatusCommands: vi.fn(() =>
          Promise.resolve({
            items: [
              { id: 'tests', intervalSeconds: 60, action: 'run tests' },
              { id: 'deploy', intervalSeconds: 60, action: 'Deploy' },
            ],
          })
        ),
        runStatusCommand: vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: `${id} item` }, ranAt: 1 })
        ),
      });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID, projectId: 'p-1' })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      const tests = { id: 'a-1', title: 'Run tests', content: 'npm test', projectIds: ['p-1'] };
      useActionsStore.setState({ actions: [tests] });
      actionMocks.runAction.mockReset();
      renderStatusBar();

      await user.click(await screen.findByRole('button', { name: 'tests item, runs run tests' }));
      expect(actionMocks.runAction).toHaveBeenCalledWith(tests);

      await user.click(screen.getByRole('button', { name: 'deploy item, runs Deploy' }));
      await vi.waitFor(() =>
        expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
          'This project has no quick command named “Deploy”. Check status-items.json.'
        )
      );
      expect(actionMocks.runAction).toHaveBeenCalledOnce();
    });

    it("opens an item's link in the browser", async () => {
      const user = userEvent.setup();
      const openExternal = vi.fn(() => Promise.resolve());
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({ id: 'pr', text: 'PR #812', link: 'https://github.com/o/r/pull/812' }),
          ])
        ),
        openExternal,
      });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      await user.click(await screen.findByRole('button', { name: 'PR #812, opens github.com' }));
      expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/812');
    });

    it('shows each custom item where the user placed it', async () => {
      mockState.config = { statusBarRightItems: ['agent:pr', 'agents'] };
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({ id: 'tests', text: '142/150 passing' }),
            item({ id: 'pr', text: 'PR #812' }),
          ])
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      const [left, right] = screen.getByTestId('status-bar').children;
      expect(right).toContainElement(await screen.findByText('PR #812'));
      expect(left).toContainElement(screen.getByText('142/150 passing'));
    });

    it('shows the output of status-items.json commands for the open workspace', async () => {
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve(
          id === 'ci'
            ? { id, workspaceId, content: { text: 'CI passing', tone: 'success' }, ranAt: 1 }
            : { id, workspaceId, content: null, error: 'gh: Not logged in', ranAt: 1 }
        )
      );
      const listStatusCommands = vi.fn(() =>
        Promise.resolve({
          items: [
            { id: 'ci', intervalSeconds: 60 },
            { id: 'prs', intervalSeconds: 60, label: 'Open PRs' },
          ],
        })
      );
      mockApi({ listStatusCommands, runStatusCommand });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      expect(await screen.findByRole('button', { name: 'CI passing' })).toBeInTheDocument();
      // A failing command shows its label, with the error on hover.
      const failed = await screen.findByRole('button', { name: 'Open PRs' });
      await userEvent.setup().hover(failed);
      expect(
        (await screen.findAllByText('Open PRs failed in status-items.json: gh: Not logged in'))
          .length
      ).toBeGreaterThan(0);
      expect(listStatusCommands).toHaveBeenCalledWith('ws-open');
      expect(runStatusCommand).toHaveBeenCalledWith('ws-open', 'ci');
    });

    it('runs each command again on its interval', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: 'ok' }, ranAt: 1 })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 30 }] })
        ),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      await act(async () => {});
      expect(runStatusCommand).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(runStatusCommand).toHaveBeenCalledTimes(2);
    });

    it("keeps each workspace's items while switching, running them only when due", async () => {
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: `CI ${workspaceId}` }, ranAt: 1 })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand,
      });
      setWorkspaces([
        createWorkspace({ id: 'ws-a', windowId: WINDOW_ID }),
        createWorkspace({ id: 'ws-b', windowId: WINDOW_ID }),
      ]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-a' });
      renderStatusBar();

      expect(await screen.findByRole('button', { name: 'CI ws-a' })).toBeInTheDocument();
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-b' }));
      expect(await screen.findByRole('button', { name: 'CI ws-b' })).toBeInTheDocument();
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-a' }));

      // Still within its interval, so it shows as it is.
      expect(screen.getByRole('button', { name: 'CI ws-a' })).not.toHaveClass('opacity-60');
      await act(async () => {});
      expect(runStatusCommand).toHaveBeenCalledTimes(2);
    });

    it('shows an item that runs on this computer the same in every workspace, run once', async () => {
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: '7d 12%' }, ranAt: 1, runOn: 'local' })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'usage', intervalSeconds: 60, runOn: 'local' }] })
        ),
        runStatusCommand,
      });
      setWorkspaces([
        createWorkspace({ id: 'ws-a', windowId: WINDOW_ID }),
        createWorkspace({ id: 'ws-b', windowId: WINDOW_ID }),
      ]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-a' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: '7d 12%' })).toBeInTheDocument();

      // Once ws-b's items are listed, it shows the same output without running it again.
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-b' }));
      expect(await screen.findByRole('button', { name: '7d 12%' })).not.toHaveClass('opacity-60');
      await act(async () => {});
      expect(runStatusCommand).toHaveBeenCalledOnce();
    });

    it('shows what a run `komla status refresh` asked for shows', async () => {
      let onResult: (result: unknown) => void = () => {};
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: 'CI failing' }, ranAt: 1 })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand,
        onStatusCommandResult: vi.fn((callback: (result: unknown) => void) => {
          onResult = callback;
          return () => {};
        }),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: 'CI failing' })).toBeInTheDocument();

      act(() =>
        onResult({ id: 'ci', workspaceId: 'ws-other', content: { text: 'Other' }, ranAt: 2 })
      );
      act(() =>
        onResult({ id: 'ci', workspaceId: 'ws-open', content: { text: 'CI passing' }, ranAt: 2 })
      );
      expect(screen.getByRole('button', { name: 'CI passing' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Other' })).not.toBeInTheDocument();
      expect(runStatusCommand).toHaveBeenCalledOnce();
    });

    it("dims a workspace's item while it catches up on a run it missed", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      let finish: () => void = () => {};
      const runStatusCommand = vi.fn(
        (workspaceId: string, id: string) =>
          new Promise((resolve) => {
            const result = { id, workspaceId, content: { text: `CI ${workspaceId}` }, ranAt: 1 };
            if (runStatusCommand.mock.calls.length <= 2) resolve(result);
            else finish = () => resolve({ ...result, content: { text: 'CI ws-a now' } });
          })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand,
      });
      setWorkspaces([
        createWorkspace({ id: 'ws-a', windowId: WINDOW_ID }),
        createWorkspace({ id: 'ws-b', windowId: WINDOW_ID }),
      ]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-a' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: 'CI ws-a' })).toBeInTheDocument();
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-b' }));
      expect(await screen.findByRole('button', { name: 'CI ws-b' })).toBeInTheDocument();

      vi.setSystemTime(Date.now() + 61_000);
      act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-a' }));
      await vi.waitFor(() => expect(runStatusCommand).toHaveBeenCalledTimes(3));
      expect(screen.getByRole('button', { name: 'CI ws-a' })).toHaveClass('opacity-60');

      await act(async () => finish());
      expect(screen.getByRole('button', { name: 'CI ws-a now' })).not.toHaveClass('opacity-60');
    });

    it('runs every item again when status-items.json changes, without dimming them', async () => {
      let onChange: () => void = () => {};
      let changedAt = 0;
      let finish: () => void = () => {};
      const runStatusCommand = vi.fn(
        (workspaceId: string, id: string) =>
          new Promise((resolve) => {
            const result = { id, workspaceId, content: { text: 'ok' }, ranAt: 1 };
            if (runStatusCommand.mock.calls.length === 1) resolve(result);
            else finish = () => resolve({ ...result, content: { text: 'edited' } });
          })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }], changedAt })
        ),
        onStatusCommandsChange: vi.fn((callback: () => void) => {
          const previous = onChange;
          onChange = () => {
            previous();
            callback();
          };
          return () => {};
        }),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: 'ok' })).toBeInTheDocument();

      changedAt = await later();
      await act(async () => onChange());
      await vi.waitFor(() => expect(runStatusCommand).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('button', { name: 'ok' })).not.toHaveClass('opacity-60');
      await act(async () => finish());
      expect(screen.getByRole('button', { name: 'edited' })).toBeInTheDocument();
    });

    it('shows a failure, not the last output, once status-items.json changed', async () => {
      let onChange: () => void = () => {};
      let changedAt = 0;
      const runStatusCommand = vi
        .fn()
        .mockImplementationOnce((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: 'CI passing' }, ranAt: 1 })
        )
        .mockImplementation((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: null, error: 'not found', ranAt: 2 })
        );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60, label: 'CI' }], changedAt })
        ),
        onStatusCommandsChange: vi.fn((callback: () => void) => {
          const previous = onChange;
          onChange = () => {
            previous();
            callback();
          };
          return () => {};
        }),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: 'CI passing' })).toBeInTheDocument();

      changedAt = await later();
      await act(async () => onChange());
      expect(await screen.findByRole('button', { name: 'CI' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'CI passing' })).not.toBeInTheDocument();
    });

    it("doesn't show a run that began before status-items.json changed once a later one ended", async () => {
      let onChange: () => void = () => {};
      let changedAt = 0;
      const finishes: Array<(text: string) => void> = [];
      const runStatusCommand = vi.fn(
        (workspaceId: string, id: string) =>
          new Promise((resolve) =>
            finishes.push((text) => resolve({ id, workspaceId, content: { text }, ranAt: 1 }))
          )
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }], changedAt })
        ),
        onStatusCommandsChange: vi.fn((callback: () => void) => {
          onChange = callback;
          return () => {};
        }),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();
      await vi.waitFor(() => expect(finishes).toHaveLength(1));

      changedAt = await later();
      await act(async () => onChange());
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      await act(async () => finishes[1]('new command'));
      await act(async () => finishes[0]('old command'));
      expect(screen.getByRole('button', { name: 'new command' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'old command' })).not.toBeInTheDocument();
    });

    it('runs the items again once shown, when status-items.json changed while the bar was hidden', async () => {
      let changedAt = 0;
      let onResult: (result: unknown) => void = () => {};
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: `run ${changedAt}` }, ranAt: 1 })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({
            items: [
              { id: 'ci', intervalSeconds: 60 },
              { id: 'pr', intervalSeconds: 60 },
            ],
            changedAt,
          })
        ),
        onStatusCommandResult: vi.fn((callback: (result: unknown) => void) => {
          onResult = callback;
          return () => {};
        }),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      const { rerender } = renderStatusBar();
      expect(await screen.findAllByRole('button', { name: 'run 0' })).toHaveLength(2);

      mockState.config = { showStatusBar: false };
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      changedAt = await later();
      act(() =>
        onResult({ id: 'pr', workspaceId: 'ws-open', content: { text: 'PR merged' }, ranAt: 2 })
      );
      runStatusCommand.mockClear();

      mockState.config = {};
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      expect(await screen.findByRole('button', { name: `run ${changedAt}` })).toBeInTheDocument();
      // Refreshed while hidden, after the change, so it doesn't run again.
      expect(screen.getByRole('button', { name: 'PR merged' })).toBeInTheDocument();
      expect(runStatusCommand).toHaveBeenCalledOnce();
    });

    it("stops dimming an item and says why when its run can't start", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const runStatusCommand = vi
        .fn()
        .mockImplementationOnce((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: 'CI passing' }, ranAt: 1 })
        )
        .mockImplementation(() => Promise.reject(new Error('No workspace ws-open')));
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();
      expect(await screen.findByRole('button', { name: 'CI passing' })).toBeInTheDocument();

      vi.setSystemTime(Date.now() + 61_000);
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      expect(runStatusCommand).toHaveBeenCalledTimes(2);
      const stale = screen.getByRole('button', { name: 'CI passing' });
      expect(stale).toHaveClass('opacity-60');
      vi.useRealTimers();
      await userEvent.setup().hover(stale);
      expect(
        (await screen.findAllByText(/The last run failed: No workspace ws-open/)).length
      ).toBeGreaterThan(0);
    });

    it("doesn't run the commands again when other settings change", async () => {
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: 'ok' }, ranAt: 1 })
      );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60 }] })
        ),
        runStatusCommand,
      });
      mockState.config = { statusBarHiddenItems: ['tips'] };
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      const { rerender } = renderStatusBar();
      expect(await screen.findByRole('button', { name: 'ok' })).toBeInTheDocument();

      // The config store holds a new copy of the config after every change.
      mockState.config = { statusBarHiddenItems: ['tips'], showStatusBar: true };
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      await act(async () => {});
      expect(runStatusCommand).toHaveBeenCalledOnce();
    });

    it('keeps showing the last output, dimmed, while the command fails', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const runStatusCommand = vi
        .fn()
        .mockImplementationOnce((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: 'CI passing' }, ranAt: 1 })
        )
        .mockImplementation((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: null, error: 'offline', ranAt: 2 })
        );
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 30 }] })
        ),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      await act(async () => {});
      expect(screen.getByRole('button', { name: 'CI passing' })).not.toHaveClass('opacity-60');
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(runStatusCommand).toHaveBeenCalledTimes(2);
      const stale = screen.getByRole('button', { name: 'CI passing' });
      expect(stale).toHaveClass('opacity-60');

      vi.useRealTimers();
      await userEvent.setup().hover(stale);
      expect((await screen.findAllByText(/The last run failed: offline/)).length).toBeGreaterThan(
        0
      );
    });

    it("says what's wrong with status-items.json", async () => {
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [], problem: 'status-items.json is not valid JSON' })
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      expect(await screen.findByRole('button', { name: 'status-items.json' })).toBeInTheDocument();
    });

    it('hides each item the user turned off, without running its command', async () => {
      mockState.config = { statusBarHiddenItems: ['command:ci', 'agent:tests'] };
      const runStatusCommand = vi.fn((workspaceId: string, id: string) =>
        Promise.resolve({ id, workspaceId, content: { text: `${id} output` }, ranAt: 1 })
      );
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([item(), item({ id: 'pr', text: 'PR #812' })])
        ),
        listStatusCommands: vi.fn(() =>
          Promise.resolve({
            items: [
              { id: 'ci', intervalSeconds: 60 },
              { id: 'prs', intervalSeconds: 60 },
            ],
          })
        ),
        runStatusCommand,
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      expect(await screen.findByRole('button', { name: 'prs output' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'PR #812' })).toBeInTheDocument();
      expect(screen.queryByText('142/150 passing')).not.toBeInTheDocument();
      expect(runStatusCommand.mock.calls).toEqual([['ws-open', 'prs']]);
    });
  });

  describe('workspace items', () => {
    function openWorkspace(overrides: Partial<ReturnType<typeof createWorkspace>> = {}) {
      const workspace = createWorkspace({ windowId: WINDOW_ID, ...overrides });
      setWorkspaces([workspace]);
      useWorkspacesStore.setState({ selectedWorkspaceId: workspace.id });
      return workspace;
    }

    it('shows the git menu, target branch and file search for the open workspace', async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarShownItems: ['file-search'] };
      useCommandCenterStore.setState(useCommandCenterStore.getInitialState(), true);
      openWorkspace();
      renderStatusBar();

      expect(screen.getByText('git menu')).toBeInTheDocument();
      expect(screen.getByText('target branch')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Search files' }));
      expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'files' });
    });

    it('hides the git menu and target branch once turned off, and file search by default', () => {
      mockState.config = { statusBarHiddenItems: ['git-menu', 'target-branch'] };
      openWorkspace();
      renderStatusBar();

      expect(screen.queryByText('git menu')).not.toBeInTheDocument();
      expect(screen.queryByText('target branch')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Search files' })).not.toBeInTheDocument();
    });

    it('shows each item on the side and in the order the user placed it', () => {
      mockState.config = {
        statusBarShownItems: ['notes'],
        statusBarLeftItems: ['notification-sounds', 'notes'],
        statusBarRightItems: ['git-menu'],
      };
      openWorkspace();
      renderStatusBar();

      const [left, right] = screen.getByTestId('status-bar').children;
      const sounds = screen.getByRole('button', { name: 'Notification sounds' });
      const notes = screen.getByRole('button', { name: 'Notes' });
      expect(left).toContainElement(sounds);
      expect(sounds.compareDocumentPosition(notes)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(right).toContainElement(screen.getByText('git menu'));
      expect(left).toContainElement(screen.getByText('target branch'));
    });

    it('leaves setup progress to the tab row', () => {
      openWorkspace();
      renderStatusBar();

      expect(screen.getByText('target branch')).toBeInTheDocument();
      expect(screen.queryByText('setup progress')).not.toBeInTheDocument();
    });

    it('leaves git progress to the git menu, showing it on its own only while the menu is hidden', () => {
      openWorkspace();
      const { rerender } = renderStatusBar();
      expect(screen.queryByText('git progress')).not.toBeInTheDocument();

      mockState.config = { statusBarHiddenItems: ['git-menu'] };
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      expect(
        screen.getByText('target branch').compareDocumentPosition(screen.getByText('git progress'))
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('opens the full-window Files and Diff viewers once turned on', async () => {
      const user = userEvent.setup();
      const workspace = openWorkspace();
      const { rerender } = renderStatusBar();
      expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Diff' })).not.toBeInTheDocument();

      mockState.config = { statusBarShownItems: ['file-viewer', 'diff-viewer'] };
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      await user.click(screen.getByRole('button', { name: 'Diff' }));

      expect(useFileViewerStore.getState()).toMatchObject({
        fileViewerWorkspaceId: workspace.id,
        fileViewerMode: 'diff',
      });
      expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    });

    it('opens the workspace in the default editor, and offers the others', async () => {
      const user = userEvent.setup();
      const openInEditor = vi.fn(() => Promise.resolve());
      mockApi({
        getAvailableEditors: vi.fn(() => Promise.resolve([{ id: 'vscode', name: 'VS Code' }])),
        openInEditor,
      });
      const workspace = openWorkspace();
      renderStatusBar();

      await user.click(await screen.findByRole('button', { name: 'Open in VS Code' }));
      expect(openInEditor).toHaveBeenCalledWith('vscode', workspace.workingDirectory);

      await user.click(screen.getByRole('button', { name: 'Open with' }));
      expect(screen.getByRole('menuitem', { name: /Set .+ as default/ })).toBeInTheDocument();
    });

    it('offers the file manager even where the old setting turned it off', async () => {
      const user = userEvent.setup();
      mockState.config = { showFinderInToolbar: false };
      mockApi({
        getAvailableEditors: vi.fn(() => Promise.resolve([{ id: 'vscode', name: 'VS Code' }])),
      });
      openWorkspace();
      renderStatusBar();

      await user.click(await screen.findByRole('button', { name: 'Open with' }));
      expect(
        screen.getByRole('menuitem', { name: /^(Finder|Explorer|Files)$/ })
      ).toBeInTheDocument();
    });

    it('leaves Open in editor out once turned off', () => {
      mockState.config = { showEditorInToolbar: false };
      openWorkspace();
      renderStatusBar();

      expect(screen.queryByRole('button', { name: /^(Open in|Show in)/ })).not.toBeInTheDocument();
    });

    it('leaves Diff out for a folder without git', () => {
      mockState.config = { statusBarShownItems: ['file-viewer', 'diff-viewer'] };
      openWorkspace({ isWorktree: false });
      renderStatusBar();

      expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Diff' })).not.toBeInTheDocument();
    });
  });

  describe('Tips', () => {
    const tipsActions = {
      onOpenShortcuts: vi.fn(),
      onOpenFeedback: vi.fn(),
      onOpenSettingsTab: vi.fn(),
      onOpenNewWorkspace: vi.fn(),
    };

    function renderWithTips() {
      return render(
        <TooltipProvider>
          <StatusBar tipsActions={tipsActions} />
        </TooltipProvider>
      );
    }

    it('shows Tips by default, and its hide link turns it off', async () => {
      const user = userEvent.setup();
      renderWithTips();

      await user.click(screen.getByRole('button', { name: 'Tips' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({ showTipsInToolbar: false });
    });

    it('names where Tips stays and moves focus there when hidden', async () => {
      const user = userEvent.setup();
      render(
        <TooltipProvider>
          <button type="button" data-tips-home="More menu">
            More
          </button>
          <StatusBar tipsActions={tipsActions} />
        </TooltipProvider>
      );

      await user.click(screen.getByRole('button', { name: 'Open Tips' }));
      expect(screen.getByText('Tips stays in the More menu')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Tips' }));
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });

    it('leaves Tips out once turned off', () => {
      mockState.config = { showTipsInToolbar: false };
      renderWithTips();

      expect(screen.queryByRole('button', { name: 'Tips' })).not.toBeInTheDocument();
    });
  });

  describe('right-click menu', () => {
    async function openCustomizePanel(user: ReturnType<typeof userEvent.setup>) {
      fireEvent.contextMenu(screen.getByTestId('status-bar'));
      await user.click(screen.getByRole('menuitem', { name: 'Customize status bar…' }));
      return screen.findByRole('dialog', { name: 'Customize status bar' });
    }

    it('opens the customize panel from elsewhere, such as Tips', async () => {
      renderStatusBar();

      act(() => useStatusBarCustomizeStore.getState().show());

      const panel = await screen.findByRole('dialog', { name: 'Customize status bar' });
      expect(within(panel).getByRole('switch', { name: 'Claude Code usage' })).not.toBeChecked();
    });

    it('offers to hide the item it was opened on', async () => {
      const user = userEvent.setup();
      renderStatusBar();

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Notification sounds' }));
      await user.click(screen.getByRole('menuitem', { name: 'Hide Notification sounds' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: ['notification-sounds'],
      });
    });

    it('offers no item to hide when opened on the bar itself', () => {
      renderStatusBar();

      fireEvent.contextMenu(screen.getByTestId('status-bar'));

      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Hide status bar',
        'Customize status bar…',
        'Add an item with your agent…',
      ]);
    });

    it('lists the items on each side of the bar in the order it shows them', async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarRightItems: ['tips', 'notes'] };
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const handles = (name: string) =>
        within(within(panel).getByRole('region', { name }))
          .getAllByRole('button', { name: /^Move / })
          .map((item) => item.getAttribute('aria-label')?.replace('Move ', ''));

      expect(handles('Right')).toEqual([
        'Tips',
        'Notes',
        'Agent activity',
        'Claude Code usage',
        'Codex usage',
        'Automations',
        'Notification sounds',
        'Keep awake',
        'SSH hosts',
        'Resource usage',
      ]);
      expect(handles('Left')).toEqual([
        'Git menu',
        'Target branch',
        'Pull request',
        'Open in editor',
        'File search',
        'Files (full window)',
        'Diff (full window)',
        'Commit graph',
      ]);
      expect(within(panel).queryByRole('region', { name: 'Sidebar' })).not.toBeInTheDocument();
    });

    it('drags an item to the other side of the bar', async () => {
      const user = userEvent.setup();
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const row = (name: string) =>
        within(panel).getByRole('button', { name: `Move ${name}` }).parentElement!;
      vi.spyOn(row('Agent activity'), 'getBoundingClientRect').mockReturnValue({
        top: 100,
        height: 28,
      } as DOMRect);
      fireEvent.dragStart(row('Notes'), { dataTransfer: { setData: vi.fn() } });
      // jsdom has no DragEvent to carry the pointer's position.
      const dragOver = createEvent.dragOver(row('Agent activity'), { dataTransfer: {} });
      Object.defineProperty(dragOver, 'clientY', { value: 120 });
      fireEvent(row('Agent activity'), dragOver);
      fireEvent.drop(row('Agent activity'), { dataTransfer: {} });

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarLeftItems: [
          'git-menu',
          'target-branch',
          'pull-request',
          'open-in-editor',
          'file-search',
          'file-viewer',
          'diff-viewer',
          'commit-graph',
        ],
        statusBarRightItems: [
          'agents',
          'notes',
          'claude-code-usage',
          'codex-usage',
          'automations',
          'notification-sounds',
          'keep-awake',
          'ssh-hosts',
          'system-metrics',
          'tips',
        ],
      });
    });

    it('moves an item with the arrow keys on its handle, keeping focus on it', async () => {
      const user = userEvent.setup();
      mockState.updateConfig.mockImplementation((update: Record<string, unknown>) => {
        mockState.config = { ...mockState.config, ...update };
      });
      const { rerender } = renderStatusBar();
      const rerenderBar = () =>
        rerender(
          <TooltipProvider>
            <StatusBar />
          </TooltipProvider>
        );

      const panel = await openCustomizePanel(user);
      within(panel).getByRole('button', { name: 'Move Agent activity' }).focus();
      await user.keyboard('{ArrowDown}');
      rerenderBar();
      expect(mockState.config).toMatchObject({
        statusBarRightItems: [
          'claude-code-usage',
          'agents',
          'codex-usage',
          'automations',
          'notification-sounds',
          'keep-awake',
          'ssh-hosts',
          'system-metrics',
          'tips',
        ],
      });

      await user.keyboard('{ArrowLeft}');
      rerenderBar();
      const left = within(panel).getByRole('region', { name: 'Left' });
      expect(within(left).getByRole('button', { name: 'Move Agent activity' })).toHaveFocus();
      expect(mockState.config).toMatchObject({
        statusBarLeftItems: [
          'git-menu',
          'agents',
          'target-branch',
          'pull-request',
          'open-in-editor',
          'file-search',
          'file-viewer',
          'diff-viewer',
          'notes',
          'commit-graph',
        ],
      });
    });

    it('moves an item again before the last move has saved', async () => {
      const user = userEvent.setup();
      mockState.updateConfig.mockReturnValue(new Promise(() => {}));
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      within(panel).getByRole('button', { name: 'Move Agent activity' }).focus();
      await user.keyboard('{ArrowDown}{ArrowDown}');

      expect(mockState.updateConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          statusBarRightItems: [
            'claude-code-usage',
            'codex-usage',
            'agents',
            'automations',
            'notification-sounds',
            'keep-awake',
            'ssh-hosts',
            'system-metrics',
            'tips',
          ],
        })
      );
      expect(within(panel).getByRole('button', { name: 'Move Agent activity' })).toHaveFocus();
    });

    it("puts an item dropped on a side's heading first on that side", async () => {
      const user = userEvent.setup();
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const heading = within(panel).getByRole('heading', { name: 'Right' });
      fireEvent.dragStart(
        within(panel).getByRole('button', { name: 'Move Notes' }).parentElement!,
        {
          dataTransfer: { setData: vi.fn() },
        }
      );
      fireEvent.dragOver(heading, { dataTransfer: {} });
      fireEvent.drop(heading, { dataTransfer: {} });

      expect(mockState.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          statusBarRightItems: [
            'notes',
            'agents',
            'claude-code-usage',
            'codex-usage',
            'automations',
            'notification-sounds',
            'keep-awake',
            'ssh-hosts',
            'system-metrics',
            'tips',
          ],
        })
      );
    });

    it('toggles items, keeping other hidden items hidden', async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarHiddenItems: ['future-item'] };
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const agents = within(panel).getByRole('switch', { name: 'Agent activity' });
      expect(agents).toBeChecked();
      await user.click(agents);

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: ['future-item', 'agents'],
      });
    });

    it("lists the open workspace's custom items in the panel, each in its place, to show or hide", async () => {
      const user = userEvent.setup();
      mockState.config = {
        statusBarHiddenItems: ['agent:tests'],
        statusBarRightItems: ['command:ci'],
      };
      mockApi({
        listStatusItems: vi.fn(() =>
          Promise.resolve([
            item({ id: 'tests', text: '142/150 passing' }),
            item({ id: 'other', workspaceId: 'ws-other', text: 'Elsewhere' }),
          ])
        ),
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'ci', intervalSeconds: 60, label: 'CI' }] })
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const left = within(panel).getByRole('region', { name: 'Left' });
      const right = within(panel).getByRole('region', { name: 'Right' });
      const ci = await within(right).findByRole('switch', { name: 'CI' });
      const tests = await within(left).findByRole('switch', { name: '142/150 passing' });
      expect(within(right).getAllByRole('button', { name: /^Move / })[0]).toHaveAccessibleName(
        'Move CI'
      );
      expect(
        within(left)
          .getAllByRole('button', { name: /^Move / })
          .at(-1)
      ).toHaveAccessibleName('Move 142/150 passing');
      expect(ci).toHaveAttribute('aria-checked', 'true');
      expect(tests).toHaveAttribute('aria-checked', 'false');
      expect(within(panel).queryByRole('switch', { name: 'Elsewhere' })).not.toBeInTheDocument();

      await user.click(ci);
      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: ['agent:tests', 'command:ci'],
      });
      await user.click(tests);
      expect(mockState.updateConfig).toHaveBeenLastCalledWith({ statusBarHiddenItems: [] });
    });

    it("moves a custom item on its own, keeping another workspace's custom items in place", async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarLeftItems: ['agent:elsewhere', 'git-menu'] };
      mockApi({
        listStatusItems: vi.fn(() => Promise.resolve([item({ id: 'tests', text: 'Tests' })])),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      (await within(panel).findByRole('button', { name: 'Move Tests' })).focus();
      await user.keyboard('{ArrowRight}');

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarLeftItems: [
          'agent:elsewhere',
          'git-menu',
          'target-branch',
          'pull-request',
          'open-in-editor',
          'file-search',
          'file-viewer',
          'diff-viewer',
          'notes',
          'commit-graph',
        ],
        statusBarRightItems: [
          'agents',
          'claude-code-usage',
          'codex-usage',
          'automations',
          'notification-sounds',
          'keep-awake',
          'ssh-hosts',
          'system-metrics',
          'tips',
          // Its row on the left, past Tips.
          'agent:tests',
        ],
      });
    });

    it('offers to hide the custom item it was opened on', async () => {
      const user = userEvent.setup();
      mockApi({ listStatusItems: vi.fn(() => Promise.resolve([item({ text: 'PR #812' })])) });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      fireEvent.contextMenu(await screen.findByRole('button', { name: 'PR #812' }));
      await user.click(screen.getByRole('menuitem', { name: 'Hide PR #812' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: ['agent:tests'],
      });
    });

    it('offers to hide a status-items.json item by its name, not what it shows', async () => {
      const user = userEvent.setup();
      mockApi({
        listStatusCommands: vi.fn(() =>
          Promise.resolve({ items: [{ id: 'usage', label: 'Claude usage', intervalSeconds: 60 }] })
        ),
        runStatusCommand: vi.fn((workspaceId: string, id: string) =>
          Promise.resolve({ id, workspaceId, content: { text: '7d 42%' }, ranAt: 1 })
        ),
      });
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      renderStatusBar();

      fireEvent.contextMenu(await screen.findByRole('button', { name: '7d 42%' }));
      await user.click(screen.getByRole('menuitem', { name: 'Hide Claude usage' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: ['command:usage'],
      });
    });

    it("adds an item with the open workspace's agent", async () => {
      const user = userEvent.setup();
      const addAgentTab = vi.fn(async () => ({ id: 'terminal-customize' }));
      mockApi({
        addAgentTab,
        getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
      });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      useLayoutStore.setState({ tabsByWorkspace: {} });
      renderStatusBar();

      fireEvent.contextMenu(screen.getByTestId('status-bar'));
      await user.click(screen.getByRole('menuitem', { name: 'Add an item with your agent…' }));

      await vi.waitFor(() =>
        expect(useLayoutStore.getState().tabsByWorkspace['ws-open']).toEqual(['terminal-customize'])
      );
      const [workspaceId, prompt] = addAgentTab.mock.calls[0] as unknown as [string, string];
      expect(workspaceId).toBe('ws-open');
      expect(prompt).toContain('komla skill customize');
      expect(prompt).toContain('status bar item');
    });

    it('adds an item with the agent from the panel, closing it', async () => {
      const user = userEvent.setup();
      const addAgentTab = vi.fn(async () => ({ id: 'terminal-customize' }));
      mockApi({
        addAgentTab,
        getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
      });
      setWorkspaces([createWorkspace({ id: 'ws-open', windowId: WINDOW_ID })]);
      useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-open' });
      useLayoutStore.setState({ tabsByWorkspace: {} });
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Add an item with your agent…' }));

      await vi.waitFor(() =>
        expect(useLayoutStore.getState().tabsByWorkspace['ws-open']).toEqual(['terminal-customize'])
      );
      const [workspaceId, prompt] = addAgentTab.mock.calls[0] as unknown as [string, string];
      expect(workspaceId).toBe('ws-open');
      expect(prompt).toContain('status bar item');
      expect(
        screen.queryByRole('dialog', { name: 'Customize status bar' })
      ).not.toBeInTheDocument();
    });

    it('adds an item from New Workspace when no workspace is open', async () => {
      const user = userEvent.setup();
      const opened = vi.fn();
      window.addEventListener(NEW_WORKSPACE_DIALOG_EVENT, opened);
      onTestFinished(() => window.removeEventListener(NEW_WORKSPACE_DIALOG_EVENT, opened));
      useDialogsStore.setState({ newWorkspaceDialogPrompt: '' });
      renderStatusBar();

      fireEvent.contextMenu(screen.getByTestId('status-bar'));
      await user.click(screen.getByRole('menuitem', { name: 'Add an item with your agent…' }));

      expect(opened).toHaveBeenCalledOnce();
      expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toContain('status bar item');
    });

    it('turns on an item that starts hidden, keeping the others turned on', async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarShownItems: ['keep-awake'] };
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const notes = within(panel).getByRole('switch', { name: 'Notes' });
      expect(notes).not.toBeChecked();
      await user.click(notes);

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarShownItems: ['keep-awake', 'notes'],
      });
    });

    it('turns resource usage on through its own setting', async () => {
      const user = userEvent.setup();
      renderStatusBar();

      const panel = await openCustomizePanel(user);
      const metrics = within(panel).getByRole('switch', { name: 'Resource usage' });
      expect(metrics).not.toBeChecked();
      await user.click(metrics);

      expect(mockState.updateConfig).toHaveBeenCalledWith({ showSystemMetrics: true });
    });

    it('resets every item to its default, once one differs', async () => {
      const user = userEvent.setup();
      mockState.config = { statusBarHiddenItems: ['agents'] };
      const { rerender } = renderStatusBar();

      const panel = await openCustomizePanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Reset' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({
        statusBarHiddenItems: [],
        statusBarShownItems: [],
        statusBarLeftItems: [],
        statusBarRightItems: [],
        showSystemMetrics: false,
        showTipsInToolbar: true,
        showEditorInToolbar: true,
      });
      mockState.config = {};
      rerender(
        <TooltipProvider>
          <StatusBar />
        </TooltipProvider>
      );
      expect(within(panel).getByRole('button', { name: 'Reset' })).toBeDisabled();
    });

    it('hides the whole bar, with an undo', async () => {
      const user = userEvent.setup();
      renderStatusBar();

      fireEvent.contextMenu(screen.getByTestId('status-bar'));
      await user.click(screen.getByRole('menuitem', { name: 'Hide status bar' }));

      expect(mockState.updateConfig).toHaveBeenCalledWith({ showStatusBar: false });
      const [toast] = useToastStore.getState().toasts;
      expect(toast.message).toContain('Settings › Appearance');
      act(() => toast.action?.onClick());
      expect(mockState.updateConfig).toHaveBeenLastCalledWith({ showStatusBar: true });
    });
  });
});

describe('runCountdown', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  it('counts down in the largest whole unit', () => {
    expect(runCountdown(25 * MINUTE, 0)).toBe('in 25m');
    expect(runCountdown(4 * HOUR + 10 * MINUTE, 0)).toBe('in 4h');
    expect(runCountdown(3 * 24 * HOUR + 5 * HOUR, 0)).toBe('in 3d');
  });

  it('rounds into the next unit rather than showing 60m or 24h', () => {
    expect(runCountdown(59.6 * MINUTE, 0)).toBe('in 1h');
    expect(runCountdown(23.6 * HOUR, 0)).toBe('in 1d');
  });

  it('says a minute for a run due now or just past', () => {
    expect(runCountdown(10_000, 0)).toBe('in 1m');
    expect(runCountdown(0, 5_000)).toBe('in 1m');
  });
});
