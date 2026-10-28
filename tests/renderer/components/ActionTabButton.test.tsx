/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionTabButton } from '../../../src/renderer/components/terminal/ActionTabButton';
import { useActionEditorStore } from '../../../src/renderer/stores/action-editor.store';

import type { Action } from '../../../src/shared/types';

// --- Mock state ---

const launchAction = vi.fn().mockResolvedValue('launched');
const loadActions = vi.fn().mockResolvedValue(undefined);

let actionsState: Action[] = [];
let defaultActionId: string | undefined;
let setupShown = false;

// --- Mocks ---

vi.mock('../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: any) =>
    selector({
      workspaces: [{ id: 'ws-1', name: 'Test', projectId: 'proj-1', defaultActionId }],
    }),
}));

vi.mock('../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  ACTIVITY_LABEL_ATTRIBUTE: 'data-activity-label',
  WorkspaceSetupActivity: ({ workspaceId, compact }: { workspaceId: string; compact?: boolean }) =>
    setupShown ? (
      <span data-testid="setup-activity">
        <span data-activity-label="" className={compact ? 'sr-only' : undefined}>
          setup of {workspaceId}
        </span>
      </span>
    ) : null,
}));

vi.mock('../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: (selector: any) =>
    selector({ presets: [{ id: 'claude', name: 'Claude Code' }] }),
}));

vi.mock('../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector?: any) => {
    const state = { actions: actionsState, loadActions };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/lib/action-launch', () => ({
  launchAction: (request: unknown) => launchAction(request),
}));

// Render the popover inline (avoids portal issues in jsdom). Its trigger opens it, and
// data-open says whether it is open.
vi.mock('../../../src/renderer/components/ui/popover', async () => {
  const { createContext, useContext } = await vi.importActual<typeof import('react')>('react');
  const OpenChange = createContext<(open: boolean) => void>(() => {});
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => (
      <OpenChange.Provider value={(next) => onOpenChange?.(next)}>
        <div data-testid="popover" data-open={String(!!open)}>
          {children}
        </div>
      </OpenChange.Provider>
    ),
    PopoverTrigger: ({ children }: React.PropsWithChildren) => {
      const onOpenChange = useContext(OpenChange);
      return <span onClick={() => onOpenChange(true)}>{children}</span>;
    },
    PopoverContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  };
});

vi.mock('../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

global.window.api = {
  copyToClipboard: vi.fn(),
} as any;

const ranAction = (id: string) =>
  expect(launchAction).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    action: expect.objectContaining({ id }),
    place: { kind: 'tab' },
  });

const option = (name: string) => screen.getByRole('option', { name: new RegExp(name) });

describe('ActionTabButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionsState = [];
    defaultActionId = undefined;
    setupShown = false;
    useActionEditorStore.setState({ request: null, pendingDeleteId: null });
  });

  describe('without actions', () => {
    it('offers to create one scoped to the workspace project', async () => {
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      const button = screen.getByRole('button', { name: 'New quick command' });
      expect(button).toHaveTextContent('Quick command');
      expect(screen.getByTestId('tooltip')).toHaveTextContent(
        'Save a command or prompt to run in one click'
      );
      await user.click(button);

      expect(useActionEditorStore.getState().request).toEqual({
        actionId: null,
        projectIds: ['proj-1'],
        returnFocus: expect.any(Function),
      });
    });

    it('counts actions scoped to another project as none', () => {
      actionsState = [
        {
          id: 'other-1',
          title: 'Other Project',
          type: 'command',
          content: 'make build',
          projectIds: ['proj-other'],
        },
      ];
      render(<ActionTabButton workspaceId="ws-1" />);

      expect(screen.getByRole('button', { name: 'New quick command' })).toBeInTheDocument();
      expect(screen.queryByText('Other Project')).not.toBeInTheDocument();
    });
  });

  describe('setup progress', () => {
    const precedes = (before: HTMLElement, after: HTMLElement) =>
      before.compareDocumentPosition(after) === Node.DOCUMENT_POSITION_FOLLOWING;

    it("shows the workspace's setup and background commands before the run button", () => {
      setupShown = true;
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
      render(<ActionTabButton workspaceId="ws-1" />);

      const setup = screen.getByTestId('setup-activity');
      expect(setup).toHaveTextContent('setup of ws-1');
      expect(precedes(setup, screen.getByRole('button', { name: 'Run Dev Server' }))).toBe(true);
    });

    it('shows it before the new quick command button too', () => {
      setupShown = true;
      render(<ActionTabButton workspaceId="ws-1" />);

      expect(
        precedes(
          screen.getByTestId('setup-activity'),
          screen.getByRole('button', { name: 'New quick command' })
        )
      ).toBe(true);
    });
  });

  describe('split button', () => {
    it('labels the run button with the last used action, runs it and keeps it', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
        { id: 'cmd-2', title: 'Tests', type: 'command', content: 'npm test', lastUsedAt: 5 },
      ];
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      const run = screen.getByRole('button', { name: 'Run Tests' });
      expect(run).toHaveTextContent('Tests');
      expect(screen.getAllByTestId('tooltip')[0]).toHaveTextContent('Run Testsnpm test');
      await user.click(run);

      await waitFor(() => ranAction('cmd-2'));
      expect(option('Tests')).toHaveAttribute('aria-selected', 'true');
    });

    it("runs the workspace's default rather than the last used action", async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
        { id: 'cmd-2', title: 'Tests', type: 'command', content: 'npm test', lastUsedAt: 5 },
      ];
      defaultActionId = 'cmd-1';
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      await user.click(screen.getByRole('button', { name: 'Run Dev Server' }));

      await waitFor(() => ranAction('cmd-1'));
    });

    it('runs an action picked from the list', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
        { id: 'cmd-2', title: 'Tests', type: 'command', content: 'npm test' },
      ];
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      await user.click(screen.getByRole('button', { name: 'More quick commands' }));
      await user.click(option('Tests'));

      await waitFor(() => ranAction('cmd-2'));
    });

    it('runs once on a double-click', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      await user.dblClick(screen.getByRole('button', { name: 'Run Dev Server' }));

      await waitFor(() => expect(launchAction).toHaveBeenCalled());
      expect(launchAction).toHaveBeenCalledTimes(1);
    });

    it('starts with the list closed when Actions come back', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
      const user = userEvent.setup();
      const { rerender } = render(<ActionTabButton workspaceId="ws-1" />);
      await user.click(screen.getByRole('button', { name: 'More quick commands' }));
      expect(screen.getByTestId('popover')).toHaveAttribute('data-open', 'true');

      // Say the next workspace shown has no Actions, and the one after does again.
      const devServer = actionsState;
      actionsState = [];
      rerender(<ActionTabButton workspaceId="ws-1" />);
      actionsState = devServer;
      rerender(<ActionTabButton workspaceId="ws-1" />);

      expect(screen.getByTestId('popover')).toHaveAttribute('data-open', 'false');
    });

    it('lists every action for the project with its agent and what it runs on hover', async () => {
      actionsState = [
        {
          id: 'scoped-1',
          title: 'Project Command',
          type: 'command',
          content: 'make build',
          projectIds: ['proj-1'],
        },
        { id: 'global-1', title: 'Global Command', type: 'command', content: 'echo hi' },
        {
          id: 'prompt-1',
          title: 'Code Review',
          type: 'prompt',
          content: 'Review this code',
          presetId: 'claude',
        },
      ];
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      expect(screen.getByRole('button', { name: 'More quick commands' })).toBeInTheDocument();
      expect(option('Project Command')).toHaveAttribute('title', 'make build');
      expect(option('Global Command')).toHaveAttribute('title', 'echo hi');
      await user.click(screen.getByRole('radio', { name: 'Prompts' }));
      expect(option('Code Review')).toHaveTextContent('Claude Code');
      expect(option('Code Review')).not.toHaveTextContent('Review this code');
    });

    it('creates a new action scoped to the project from the list', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      await user.click(screen.getByRole('button', { name: 'New quick command' }));
      expect(useActionEditorStore.getState().request).toEqual({
        actionId: null,
        projectIds: ['proj-1'],
        returnFocus: expect.any(Function),
      });
      expect(launchAction).not.toHaveBeenCalled();

      // The list is gone by the time the editor closes, so focus goes back to its caret.
      useActionEditorStore.getState().request?.returnFocus?.();
      expect(screen.getByRole('button', { name: 'More quick commands' })).toHaveFocus();
    });

    it('opens Settings from Manage', async () => {
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
      const settingsHandler = vi.fn();
      window.addEventListener('open-settings', settingsHandler);
      const user = userEvent.setup();
      render(<ActionTabButton workspaceId="ws-1" />);

      await user.click(screen.getByRole('button', { name: 'Manage' }));

      expect(settingsHandler).toHaveBeenCalledWith(expect.objectContaining({ detail: 'actions' }));
      window.removeEventListener('open-settings', settingsHandler);
    });
  });

  describe('when the tabs crowd it', () => {
    // jsdom has no layout: the slot's width is set per test, the button is 48px wide
    // without its label and 48 + 6 + the label with it; the 80px label truncates to fit.
    // Setup progress, when shown, is 40px wide, 14px without its 20px label and gap.
    let slotWidth = 0;
    let resize: () => void = () => {};

    beforeEach(() => {
      const isLabelHidden = () =>
        document.querySelector('.max-w-24')?.parentElement?.classList.contains('sr-only') ?? false;
      const isSetupLabelHidden = () =>
        document.querySelector('[data-activity-label]')?.classList.contains('sr-only') ?? false;
      const setupWidth = () => (setupShown ? (isSetupLabelHidden() ? 14 : 40) : 0);
      const labelWidth = () =>
        isLabelHidden() ? 1 : Math.max(0, Math.min(80, slotWidth - setupWidth() - 54));
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.classList.contains('min-w-min')) return slotWidth;
        return this.classList.contains('max-w-24') ? labelWidth() : 0;
      });
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.firstElementChild?.getAttribute('data-testid') === 'setup-activity') {
          return setupWidth();
        }
        if (!this.classList.contains('group/action-split')) return 0;
        return isLabelHidden() ? 48 : 48 + 6 + labelWidth();
      });
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.hasAttribute('data-activity-label')) return 20;
        return this.classList.contains('max-w-24') ? 80 : 0;
      });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe() {}
          disconnect() {}
        }
      );
      actionsState = [
        { id: 'cmd-1', title: 'Dev Server', type: 'command', content: 'npm run dev' },
      ];
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    const label = () =>
      screen.getByRole('button', { name: 'Run Dev Server' }).querySelector('.max-w-24')!
        .parentElement;
    const resizeTo = (width: number) => {
      slotWidth = width;
      act(() => resize());
    };

    it('truncates its label, then drops it, until the label minimum fits again', () => {
      slotWidth = 300;
      render(<ActionTabButton workspaceId="ws-1" />);
      expect(label()).not.toHaveClass('sr-only');

      // Truncated to 60px, still shown.
      resizeTo(48 + 6 + 60);
      expect(label()).not.toHaveClass('sr-only');

      // Less than 48px of it would show.
      resizeTo(48 + 6 + 46);
      expect(label()).toHaveClass('sr-only');
      expect(screen.getByRole('button', { name: 'Run Dev Server' })).toBeInTheDocument();

      // It comes back once 6 + 48px fit, plus some slack.
      resizeTo(48 + 6 + 48 + 7);
      expect(label()).toHaveClass('sr-only');
      resizeTo(48 + 6 + 48 + 8);
      expect(label()).not.toHaveClass('sr-only');
      act(() => resize());
      expect(label()).not.toHaveClass('sr-only');
    });

    it('leaves room for setup progress before it', () => {
      setupShown = true;
      slotWidth = 300;
      render(<ActionTabButton workspaceId="ws-1" />);
      expect(label()).not.toHaveClass('sr-only');

      resizeTo(40 + 48 + 6 + 46);
      expect(label()).toHaveClass('sr-only');

      // The label minimum, its slack and the setup progress must all fit.
      resizeTo(40 + 48 + 6 + 48 + 7);
      expect(label()).toHaveClass('sr-only');
      resizeTo(40 + 48 + 6 + 48 + 8);
      expect(label()).not.toHaveClass('sr-only');
    });

    it('drops the setup progress label too once the tabs can shrink no further', () => {
      setupShown = true;
      slotWidth = 300;
      const tabRoom = { px: 100 };
      render(<ActionTabButton workspaceId="ws-1" tabRoom={tabRoom} />);
      const setupLabel = () => screen.getByText('setup of ws-1');
      const tabsShrinkTo = (px: number) => {
        tabRoom.px = px;
        act(() => tabRoom.onChange?.());
      };

      resizeTo(40 + 48 + 6 + 46);
      expect(label()).toHaveClass('sr-only');
      expect(setupLabel()).not.toHaveClass('sr-only');

      // The tabs can still give up room: the progress keeps its label.
      tabsShrinkTo(1);
      expect(setupLabel()).not.toHaveClass('sr-only');

      tabsShrinkTo(0);
      expect(setupLabel()).toHaveClass('sr-only');
      expect(label()).toHaveClass('sr-only');

      // It comes back once the tabs have room for its label and gap, plus some slack.
      tabsShrinkTo(6 + 20 + 7);
      expect(setupLabel()).toHaveClass('sr-only');
      tabsShrinkTo(6 + 20 + 8);
      expect(setupLabel()).not.toHaveClass('sr-only');
      expect(label()).toHaveClass('sr-only');
    });

    it('keeps the setup progress label without word from the tabs', () => {
      setupShown = true;
      slotWidth = 300;
      render(<ActionTabButton workspaceId="ws-1" />);

      resizeTo(40 + 48);
      expect(label()).toHaveClass('sr-only');
      expect(screen.getByText('setup of ws-1')).not.toHaveClass('sr-only');
    });
  });
});
