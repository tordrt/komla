/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render as renderUi, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import {
  SetupActivityIndicator,
  SetupActivityNotifications,
  SetupActivityPanel,
} from '../../../../src/renderer/components/workspaces/SetupActivityPanel';

import type { Workspace } from '../../../../src/shared/types';

const retrySetupStep = vi.fn(() => Promise.resolve());
const dismissSetupActivity = vi.fn(() => Promise.resolve());
const runBackgroundAction = vi.fn(() => Promise.resolve());
const stopBackgroundActionRun = vi.fn(() => Promise.resolve());
const addToast = vi.hoisted(() => vi.fn());
const selectWorkspace = vi.hoisted(() => vi.fn());

vi.mock('@/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

vi.mock('@/stores/workspaces.store', () => ({
  useWorkspacesStore: { getState: () => ({ selectWorkspace }) },
}));

const render = (ui: React.ReactElement) => renderUi(ui, { wrapper: TooltipProvider });

function workspaceWithFailure(): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace',
    workingDirectory: '/repo',
    isWorktree: true,
    projectId: 'project-1',
    terminals: [],
    windowId: null,
    categoryId: null,
    createdAt: 1,
    lastActivityAt: 1,
    order: 0,
    status: 'active',
    setupActivities: [
      {
        id: 'run-1',
        workspaceId: 'ws-1',
        setupRunId: 'setup-run-1',
        stepId: 'step-1',
        stepName: 'Install dependencies',
        retryable: true,
        state: 'failed',
        startedAt: 1,
        completedAt: 2,
        exitCode: 1,
        error: 'Command exited with code 1',
        output: 'package install failed',
      },
    ],
  };
}

describe('SetupActivityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      api: { retrySetupStep, dismissSetupActivity, runBackgroundAction, stopBackgroundActionRun },
    });
  });

  it('shows diagnostic output and retries or dismisses one run', async () => {
    render(<SetupActivityPanel workspace={workspaceWithFailure()} />);

    expect(screen.getByText(/package install failed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(retrySetupStep).toHaveBeenCalledWith('ws-1', 'step-1');
    expect(dismissSetupActivity).toHaveBeenCalledWith('ws-1', 'run-1');
  });

  it('shows output without terminal escape codes, scrolled to its end', () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0]!.output =
      '\x1b[?2004h\x1b]0;user@host: /repo\x07\x1b[01;32muser@host\x1b[00m$ npm ci\r\nadded 12 packages\r\n';
    const scrollTops: number[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 400,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (value: number) => scrollTops.push(value),
    });

    try {
      render(<SetupActivityPanel workspace={workspace} />);
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    }

    const output = screen.getByText(/added 12 packages/);
    expect(output.textContent).toBe(
      'Command exited with code 1\nuser@host$ npm ci\nadded 12 packages\n'
    );
    expect(scrollTops).toContain(400);
  });

  it('shows a line a command redrew with carriage returns as it ended', () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0]!.error = undefined;
    workspace.setupActivities![0]!.output =
      'Downloading 10%\rDownloading 55%\rDownloading 100%\r\ndone\r\nwaiting\r';

    render(<SetupActivityPanel workspace={workspace} />);

    expect(screen.getByText(/done/).textContent).toBe('Downloading 100%\ndone\nwaiting');
  });

  it("leaves out the shell's echo of the command Komla typed and its logout", () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0]!.error = undefined;
    workspace.setupActivities![0]!.output =
      'user@host:/repo$ npm ci; exit $?\r\nadded 12 packages\r\nlogout\r\n';

    render(<SetupActivityPanel workspace={workspace} />);

    expect(screen.getByText(/added 12 packages/).textContent).toBe('added 12 packages');
  });

  it('folds away the output of a run that succeeded until it is opened', async () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0] = {
      ...workspace.setupActivities![0]!,
      state: 'succeeded',
      completedAt: 12_001,
      exitCode: 0,
      error: undefined,
      output: 'added 12 packages',
    };

    render(<SetupActivityPanel workspace={workspace} />);

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('12s')).toBeInTheDocument();
    expect(screen.queryByText('added 12 packages')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Install dependencies' }));
    expect(screen.getByText('added 12 packages')).toBeInTheDocument();
  });

  it('follows new output only while scrolled to the end', () => {
    const workspace = workspaceWithFailure();
    let scrollTop = 0;
    const scrolledTo: number[] = [];
    Object.defineProperties(HTMLElement.prototype, {
      scrollHeight: { configurable: true, get: () => 400 },
      clientHeight: { configurable: true, get: () => 128 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          scrolledTo.push(value);
        },
      },
    });

    try {
      const { rerender } = render(<SetupActivityPanel workspace={workspace} />);
      const output = screen.getByText(/package install failed/);
      expect(scrolledTo).toEqual([400]);

      // The user scrolls up to read; new output leaves them there.
      scrollTop = 40;
      fireEvent.scroll(output);
      workspace.setupActivities![0]!.output += '\nmore';
      rerender(<SetupActivityPanel workspace={{ ...workspace }} />);
      expect(scrolledTo).toEqual([400]);

      // Back at the end, it follows again.
      scrollTop = 400 - 128;
      fireEvent.scroll(output);
      workspace.setupActivities![0]!.output += '\nlast';
      rerender(<SetupActivityPanel workspace={{ ...workspace }} />);
      expect(scrolledTo).toEqual([400, 400]);
    } finally {
      for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  });

  it('shows active workspace Setup progress in a clickable top-bar indicator', async () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0] = {
      ...workspace.setupActivities![0]!,
      state: 'running',
      completedAt: undefined,
      exitCode: undefined,
      error: undefined,
      output: 'installing packages',
    };

    render(<SetupActivityIndicator workspace={workspace} />);

    await userEvent.click(screen.getByRole('button', { name: 'Setup running: 0 of 1 complete' }));
    expect(screen.getByText('Install dependencies')).toBeInTheDocument();
    expect(screen.getByText('installing packages')).toBeInTheDocument();
  });

  it('shows only its icon when compact, keeping its name and the label as a tooltip', async () => {
    render(<SetupActivityIndicator workspace={workspaceWithFailure()} compact />);

    const indicator = screen.getByRole('button', { name: 'Setup failed: 1 problem' });
    expect(screen.getByText('Setup failed (1)')).toHaveClass('sr-only');
    await userEvent.hover(indicator);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Setup failed (1)');
  });

  it('briefly confirms successful Setup and then leaves the top bar', () => {
    vi.useFakeTimers();
    try {
      const runningWorkspace = workspaceWithFailure();
      runningWorkspace.setupActivities![0] = {
        ...runningWorkspace.setupActivities![0]!,
        state: 'running',
        completedAt: undefined,
        exitCode: undefined,
        error: undefined,
      };
      const { rerender } = render(<SetupActivityIndicator workspace={runningWorkspace} />);

      const succeededWorkspace = workspaceWithFailure();
      succeededWorkspace.setupActivities![0] = {
        ...succeededWorkspace.setupActivities![0]!,
        state: 'succeeded',
        exitCode: 0,
        error: undefined,
      };
      rerender(<SetupActivityIndicator workspace={succeededWorkspace} />);

      expect(screen.getByRole('button', { name: 'Setup complete' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.queryByRole('button', { name: 'Setup complete' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps failed Setup visible until the user handles it', () => {
    vi.useFakeTimers();
    try {
      render(<SetupActivityIndicator workspace={workspaceWithFailure()} />);

      expect(screen.getByRole('button', { name: 'Setup failed: 1 problem' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByRole('button', { name: 'Setup failed: 1 problem' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurface successful activity from an older Setup run', async () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities = [
      {
        ...workspace.setupActivities![0]!,
        id: 'old-success',
        setupRunId: 'old-run',
        stepName: 'Old successful install',
        state: 'succeeded',
        exitCode: 0,
        error: undefined,
      },
      workspace.setupActivities![0]!,
    ];

    render(<SetupActivityIndicator workspace={workspace} />);
    await userEvent.click(screen.getByRole('button', { name: 'Setup failed: 1 problem' }));

    expect(screen.getByText('Install dependencies')).toBeInTheDocument();
    expect(screen.queryByText('Old successful install')).not.toBeInTheDocument();
  });

  it('announces multiple unsupported steps once for their Setup run', () => {
    const workspace = workspaceWithFailure();
    const runs = [
      {
        ...workspace.setupActivities![0],
        state: 'unsupported' as const,
        stepName: 'Local install',
      },
      {
        ...workspace.setupActivities![0],
        id: 'run-2',
        stepId: 'step-2',
        state: 'unsupported' as const,
        stepName: 'Local env',
      },
    ];

    render(<SetupActivityNotifications workspace={workspace} runs={runs} />);

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      'Setup unsupported in Workspace: Local install, Local env',
      'info',
      expect.objectContaining({ dismissOnTimeout: false })
    );
    const options = addToast.mock.calls[0]?.[2];
    options.action.onClick();
    expect(selectWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('does not offer Retry for a visible Setup failure', () => {
    const workspace = workspaceWithFailure();
    workspace.setupActivities![0]!.retryable = false;

    render(<SetupActivityPanel workspace={workspace} />);

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  describe('background Actions', () => {
    function workspaceWithActionRun(
      run: Partial<NonNullable<Workspace['setupActivities']>[number]>
    ): Workspace {
      const workspace = workspaceWithFailure();
      workspace.setupActivities = [
        {
          ...workspace.setupActivities![0]!,
          stepId: 'watch-ci',
          stepName: 'Watch CI',
          actionId: 'watch-ci',
          command: 'gh pr checks 12 --watch',
          executionLocation: 'workspace',
          ...run,
        },
      ];
      return workspace;
    }

    it('names a running Action and stops it', async () => {
      const workspace = workspaceWithActionRun({
        state: 'running',
        completedAt: undefined,
        exitCode: undefined,
        error: undefined,
        output: 'checks pending',
      });

      render(<SetupActivityIndicator workspace={workspace} />);
      await userEvent.click(screen.getByRole('button', { name: 'Watch CI running' }));
      expect(screen.getByText('Background Quick Commands')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

      expect(stopBackgroundActionRun).toHaveBeenCalledWith('ws-1', 'run-1');
    });

    it('runs a failed Action again the same way', async () => {
      render(<SetupActivityIndicator workspace={workspaceWithActionRun({})} />);

      await userEvent.click(screen.getByRole('button', { name: 'Watch CI failed' }));
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(runBackgroundAction).toHaveBeenCalledWith('ws-1', 'watch-ci', {
        command: 'gh pr checks 12 --watch',
        executionLocation: 'workspace',
      });
      expect(retrySetupStep).not.toHaveBeenCalled();
    });

    it('leaves announcing a failed Action to its notification', () => {
      const workspace = workspaceWithActionRun({ setupRunId: 'action-run-1' });

      render(
        <SetupActivityNotifications workspace={workspace} runs={workspace.setupActivities!} />
      );

      expect(addToast).not.toHaveBeenCalled();
    });
  });
});
