/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AutomationsTab } from '../../../../../src/renderer/components/layout/settings/AutomationsTab';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type {
  Automation,
  AutomationTargetSnapshot,
} from '../../../../../src/shared/types/automation';

vi.mock('../../../../../src/renderer/components/layout/settings/AutomationEditorDialog', () => ({
  AutomationEditorDialog: ({
    automation,
    template,
  }: {
    automation: Automation | null;
    template?: { label: string };
  }) => (
    <div>Automation editor for {automation?.name ?? template?.label ?? 'a new automation'}</div>
  ),
}));

const store = {
  snapshots: [] as AutomationTargetSnapshot[],
  hasLoaded: true,
  loadAutomations: vi.fn(),
  subscribeToChanges: vi.fn(() => () => {}),
  saveAutomation: vi.fn(),
  setAutomationEnabled: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomationNow: vi.fn(),
};
vi.mock('../../../../../src/renderer/stores/automations.store', () => ({
  useAutomationsStore: () => store,
}));

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [{ id: 'p1', name: 'web-app' }] }),
}));

vi.mock('../../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({ presets: [], loadPresets: vi.fn() }),
}));

vi.mock('../../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: () => ({ hosts: [{ id: 'h1', name: 'devbox' }], loadHosts: vi.fn() }),
}));

const selectWorkspace = vi.fn();
vi.mock('../../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: unknown) => unknown) =>
    selector({ workspaces: [{ id: 'ws-1' }], selectWorkspace }),
}));

const addToast = vi.fn();
vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => unknown) =>
    selector({ addToast }),
}));

const automation: Automation = {
  id: 'triage',
  name: 'Morning triage',
  prompt: 'Label new issues',
  projectId: 'p1',
  target: { kind: 'ssh', hostId: 'h1' },
  agentName: 'Codex',
  schedule: { cron: '30 8 * * 1-5', timeZone: 'Europe/Oslo' },
  enabled: true,
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1,
};

function renderTab(onClose = vi.fn()) {
  render(
    <TooltipProvider>
      <AutomationsTab onClose={onClose} />
    </TooltipProvider>
  );
}

describe('AutomationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.snapshots = [];
  });

  it('opens a new automation from the empty state', async () => {
    const user = userEvent.setup();
    store.snapshots = [
      { target: { kind: 'local' }, automations: [], runs: {}, scheduler: { available: true } },
    ];
    renderTab();

    expect(screen.getByText('No automations yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New automation' }));

    expect(screen.getByText('Automation editor for a new automation')).toBeInTheDocument();
  });

  it('opens a template in the editor from the empty state', async () => {
    const user = userEvent.setup();
    store.snapshots = [
      { target: { kind: 'local' }, automations: [], runs: {}, scheduler: { available: true } },
    ];
    renderTab();

    expect(screen.getByText('Start from a template')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Morning issue triage/ }));

    expect(screen.getByText('Automation editor for Morning issue triage')).toBeInTheDocument();
  });

  it('says why this computer’s automations couldn’t be read', () => {
    store.snapshots = [
      {
        target: { kind: 'local' },
        automations: [],
        runs: {},
        scheduler: { available: true },
        error: 'A newer version of Komla saved the automations on this computer.',
      },
    ];
    renderTab();

    expect(
      screen.getByText('A newer version of Komla saved the automations on this computer.')
    ).toBeInTheDocument();
  });

  it('shows a host’s automations with their schedule, last run, and a link to its workspace', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    store.snapshots = [
      { target: { kind: 'local' }, automations: [], runs: {}, scheduler: { available: true } },
      {
        target: { kind: 'ssh', hostId: 'h1' },
        automations: [automation],
        runs: {
          triage: [
            {
              id: 'r1',
              automationId: 'triage',
              trigger: 'schedule',
              startedAt: Date.now() - 60_000,
              status: 'started',
              workspaceId: 'ws-1',
            },
          ],
        },
        scheduler: { available: false, message: 'cron isn’t installed on this host.' },
      },
    ];
    renderTab(onClose);

    expect(screen.getByText('devbox')).toBeInTheDocument();
    expect(screen.getByText('Weekdays at 08:30 · web-app · Codex')).toBeInTheDocument();
    expect(screen.getByText(/cron isn’t installed on this host/)).toBeInTheDocument();
    expect(screen.getByText(/Last run started/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(selectWorkspace).toHaveBeenCalledWith('ws-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('runs, turns off, and edits an automation on its target', async () => {
    const user = userEvent.setup();
    store.runAutomationNow.mockResolvedValue({
      status: 'failed',
      message: 'Start one workspace for this project on this host first.',
    });
    store.snapshots = [
      {
        target: { kind: 'ssh', hostId: 'h1' },
        automations: [automation],
        runs: {},
        scheduler: { available: true },
      },
    ];
    renderTab();

    await user.click(screen.getByRole('button', { name: 'Run Morning triage now' }));
    expect(store.runAutomationNow).toHaveBeenCalledWith({ kind: 'ssh', hostId: 'h1' }, 'triage');
    expect(addToast).toHaveBeenCalledWith(
      'Start one workspace for this project on this host first.',
      'error'
    );

    await user.click(screen.getByRole('switch', { name: 'Turn off Morning triage' }));
    expect(store.setAutomationEnabled).toHaveBeenCalledWith(
      { kind: 'ssh', hostId: 'h1' },
      'triage',
      false
    );

    await user.click(screen.getByRole('button', { name: 'Edit Morning triage' }));
    expect(screen.getByText('Automation editor for Morning triage')).toBeInTheDocument();
  });

  it('keeps the templates once there are automations', async () => {
    const user = userEvent.setup();
    store.snapshots = [
      {
        target: { kind: 'local' },
        automations: [automation],
        runs: {},
        scheduler: { available: true },
      },
    ];
    renderTab();

    expect(screen.getByText('Start from a template')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Flaky test hunt/ }));
    expect(screen.getByText('Automation editor for Flaky test hunt')).toBeInTheDocument();
  });
});
