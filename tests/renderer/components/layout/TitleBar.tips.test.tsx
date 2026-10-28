/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

// Real menu, popover and Tips components: opening Tips from the settings menu depends on
// how Radix moves focus when the menu closes, which mocks can't reproduce.

const mockState = vi.hoisted(() => ({
  configStore: {
    config: {},
    updateConfig: vi.fn(),
    hasProjects: true,
  },
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector?: (state: typeof mockState.configStore) => unknown) =>
    selector ? selector(mockState.configStore) : mockState.configStore,
}));
vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (state: { isFullscreen: boolean }) => unknown) =>
    selector({ isFullscreen: false }),
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: object) => unknown) =>
    selector({ selectedWorkspaceId: null, workspaces: [] }),
}));
vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: () => ({ fileViewerWorkspaceId: null, fileViewerMode: 'browse' }),
}));
vi.mock('../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: (selector: (state: object) => unknown) =>
    selector({ getDisplayShortcut: (shortcut: string) => shortcut }),
}));
vi.mock('../../../../src/renderer/stores/license.store', () => ({
  useLicenseStore: (selector: (state: object) => unknown) => selector({ quota: null }),
}));
vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({
    presets: [],
    activePreset: null,
    activePresets: [],
    loadPresets: () => Promise.resolve(),
  }),
}));
vi.mock('../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityIndicator: () => null,
}));
vi.mock('../../../../src/renderer/components/layout/TargetBranchSelector', () => ({
  TargetBranchSelector: () => null,
}));
vi.mock('../../../../src/renderer/components/layout/UnifiedMenu', () => ({
  UnifiedMenu: () => null,
}));

const notConfigured = () => Promise.resolve({ isConfigured: false });

Object.assign(window as any, {
  api: {
    platform: 'darwin',
    getAvailableEditors: () => new Promise(() => {}),
    getServerPort: () => Promise.resolve(52863),
    getBasePath: () => Promise.resolve('/Users/test/.komla'),
    getNotificationHookDetails: notConfigured,
    getCodexNotificationHookDetails: notConfigured,
    getAntigravityNotificationHookDetails: notConfigured,
    getOpenCodeNotificationHookDetails: notConfigured,
    getMcpStatus: notConfigured,
    getKomlaSkillStatus: notConfigured,
    voiceGetModelStatus: () => Promise.resolve('not-downloaded'),
    listSshHosts: () => Promise.resolve([]),
    listAutomations: () => Promise.resolve([]),
    pairedDevicesList: () => Promise.resolve([]),
  },
});

let TitleBar: typeof import('../../../../src/renderer/components/layout/TitleBar').TitleBar;

const onOpenShortcuts = vi.fn();

function renderTitleBar() {
  const titleBar = () => (
    <TooltipProvider>
      <TitleBar
        onOpenSettings={vi.fn()}
        onOpenShortcuts={onOpenShortcuts}
        onOpenFeedback={vi.fn()}
        onOpenSettingsTab={vi.fn()}
        onOpenNewWorkspace={vi.fn()}
      />
    </TooltipProvider>
  );
  const view = render(titleBar());
  return { rerender: () => view.rerender(titleBar()) };
}

const moreButton = () => screen.getByRole('button', { name: 'Settings' });
const tipsPopover = () => screen.queryByRole('dialog');

// Lets the menu finish closing and hand focus back, which is what dismissed Tips.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

async function openTipsFromSettingsMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(moreButton());
  await user.click(await screen.findByRole('menuitem', { name: 'Tips' }));
  await settle();
}

describe('TitleBar Tips', { timeout: 30000 }, () => {
  beforeAll(async () => {
    ({ TitleBar } = await import('../../../../src/renderer/components/layout/TitleBar'));
  }, 60_000);

  beforeEach(() => {
    mockState.configStore.config = {};
    mockState.configStore.updateConfig = vi.fn();
    onOpenShortcuts.mockClear();
  });

  it('leaves Tips to the status bar by default', async () => {
    const user = userEvent.setup();
    renderTitleBar();

    expect(screen.queryByRole('button', { name: 'Tips' })).not.toBeInTheDocument();
    await user.click(moreButton());
    expect(await screen.findByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Tips' })).not.toBeInTheDocument();
  });

  it('offers Tips in the settings menu while the status bar is hidden', async () => {
    const user = userEvent.setup();
    mockState.configStore.config = { showStatusBar: false };
    renderTitleBar();

    await openTipsFromSettingsMenu(user);

    expect(tipsPopover()).toHaveTextContent('Run project setup skill');
  });

  it('opens Tips from the settings menu when the status bar leaves it out, and keeps it open', async () => {
    const user = userEvent.setup();
    mockState.configStore.config = { showTipsInToolbar: false };
    renderTitleBar();

    expect(screen.queryByRole('button', { name: 'Tips' })).not.toBeInTheDocument();
    await openTipsFromSettingsMenu(user);

    expect(tipsPopover()).toHaveTextContent('Run project setup skill');
    expect(moreButton()).toHaveFocus();
    expect(mockState.configStore.updateConfig).toHaveBeenCalledWith({
      onboardingTipsViewed: true,
    });
  });

  it('leaves the hide link out when Tips opens from the settings menu', async () => {
    const user = userEvent.setup();
    mockState.configStore.config = { showTipsInToolbar: false };
    renderTitleBar();

    await openTipsFromSettingsMenu(user);

    expect(tipsPopover()).toHaveTextContent('Run project setup skill');
    expect(screen.queryByRole('button', { name: 'Hide from status bar' })).not.toBeInTheDocument();
  });

  it('opens Tips from the settings menu by keyboard', async () => {
    const user = userEvent.setup();
    mockState.configStore.config = { showTipsInToolbar: false };
    renderTitleBar();

    moreButton().focus();
    await user.keyboard('{Enter}');
    const tipsItem = await screen.findByRole('menuitem', { name: 'Tips' });
    for (let i = 0; i < 5 && document.activeElement !== tipsItem; i++) {
      await user.keyboard('{ArrowDown}');
    }
    await user.keyboard('{Enter}');
    await settle();

    expect(tipsPopover()).toHaveTextContent('Run project setup skill');
    expect(moreButton()).toHaveFocus();
  });

  it('runs other settings menu items without opening Tips', async () => {
    const user = userEvent.setup();
    mockState.configStore.config = { showTipsInToolbar: false };
    renderTitleBar();

    await user.click(moreButton());
    await user.click(await screen.findByRole('menuitem', { name: 'Shortcuts' }));
    await settle();

    expect(onOpenShortcuts).toHaveBeenCalledOnce();
    expect(tipsPopover()).not.toBeInTheDocument();
  });
});
