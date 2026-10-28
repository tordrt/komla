/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewWorkspaceDialog } from '../../../../src/renderer/components/workspaces/NewWorkspaceDialog';
import { useShortcuts } from '../../../../src/renderer/hooks/useShortcuts';
import { isShortcutEventClaimed } from '../../../../src/renderer/lib/shortcut-claims';
import { useGitStatusStore } from '../../../../src/renderer/stores/git-status.store';
import { dismissLaunchUndo } from '../../../../src/renderer/stores/launch-undo.store';
import { useOpenFolderStore } from '../../../../src/renderer/stores/open-folder.store';
import { useSettingsDialogStore } from '../../../../src/renderer/stores/settings-dialog.store';
import { useShortcutsStore } from '../../../../src/renderer/stores/shortcuts.store';
import { seedShortcuts } from '../../../helpers/shortcuts';
import { useSshHostDialogStore } from '../../../../src/renderer/stores/ssh-host-dialog.store';

const getLaunchButton = () => screen.getByRole('button', { name: /^launch(?: \d+)? ↵$/i });

const mockProjects = [
  {
    id: 'project-komla',
    name: 'Komla Project',
    color: '#f00',
    defaultBranchPrefix: 'komla/',
    managed: false,
    repositoryPath: '/repos/komla',
  },
  {
    id: 'project-empty',
    name: 'Empty Prefix Project',
    color: '#0f0',
    defaultBranchPrefix: '',
    managed: false,
    repositoryPath: '/repos/empty',
  },
] as any[];

vi.mock('../../../../src/shared/lib/random-names', () => ({
  generateBranchSuffix: vi.fn(() => 'swift-fox'),
  branchSuffixToName: vi.fn((value: string) => value),
}));

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    onKeyDown,
  }: React.PropsWithChildren<{ onKeyDown?: React.KeyboardEventHandler<HTMLDivElement> }>) => (
    <div onKeyDown={onKeyDown}>{children}</div>
  ),
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
    ...props
  }: React.PropsWithChildren<
    React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
      asChild?: boolean;
    }
  >) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => {
  const OpenContext = React.createContext<
    { open: boolean; onOpenChange: (open: boolean) => void } | undefined
  >(undefined);
  const RadioContext = React.createContext<((value: string) => void) | undefined>(undefined);

  return {
    DropdownMenu: ({
      children,
      onOpenChange,
      modal,
      open,
    }: React.PropsWithChildren<{
      onOpenChange?: (open: boolean) => void;
      modal?: boolean;
      open?: boolean;
    }>) => {
      const [internalOpen, setInternalOpen] = React.useState(false);
      const effectiveOpen = open ?? internalOpen;
      const handleOpenChange = (nextOpen: boolean) => {
        setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
      };

      return (
        <OpenContext.Provider value={{ open: effectiveOpen, onOpenChange: handleOpenChange }}>
          <div data-modal={String(modal ?? true)} data-open={String(effectiveOpen)}>
            {children}
          </div>
        </OpenContext.Provider>
      );
    },
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: React.PropsWithChildren<{ onValueChange?: (value: string) => void }>) => (
      <RadioContext.Provider value={onValueChange}>{children}</RadioContext.Provider>
    ),
    DropdownMenuRadioItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => {
      const onValueChange = React.useContext(RadioContext);
      return (
        <button type="button" role="menuitemradio" onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => {
      const menu = React.useContext(OpenContext);
      return <div onClick={() => menu?.onOpenChange(!menu.open)}>{children}</div>;
    },
    DropdownMenuContent: ({
      children,
      className,
      onWheel,
    }: React.PropsWithChildren<{
      className?: string;
      onWheel?: React.WheelEventHandler<HTMLDivElement>;
    }>) => (
      <div className={className} data-dropdown-content onWheel={onWheel}>
        {children}
      </div>
    ),
    DropdownMenuItem: ({
      children,
      onClick,
      onSelect,
      ...props
    }: React.PropsWithChildren<
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        onSelect?: (event: { preventDefault: () => void }) => void;
      }
    >) => (
      <button
        type="button"
        onClick={() => {
          onClick?.({} as any);
          onSelect?.({ preventDefault: vi.fn() });
        }}
        {...props}
      >
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
      onSelect,
      ...props
    }: React.PropsWithChildren<
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        checked?: boolean;
        onCheckedChange?: (checked: boolean) => void;
        onSelect?: (event: { preventDefault: () => void }) => void;
      }
    >) => (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => {
          onSelect?.({ preventDefault: vi.fn() });
          onCheckedChange?.(!checked);
        }}
        {...props}
      >
        {children}
      </button>
    ),
    DropdownMenuSub: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    DropdownMenuSubTrigger: ({
      children,
      ...props
    }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    DropdownMenuSubContent: ({
      children,
      className,
      onWheel,
    }: React.PropsWithChildren<{
      className?: string;
      onWheel?: React.WheelEventHandler<HTMLDivElement>;
    }>) => (
      <div className={className} data-dropdown-sub-content onWheel={onWheel}>
        {children}
      </div>
    ),
    DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  };
});

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('../../../../src/renderer/components/workspaces/WorkspaceBranchPicker', () => ({
  WorkspaceBranchPicker: ({
    trigger,
    onSelectBase,
    onOpenBranch,
  }: {
    trigger: React.ReactNode;
    onSelectBase: (branch: string, meta: { isRemoteOnly: boolean; onHost?: true }) => void;
    onOpenBranch: (branch: string, meta: { isRemoteOnly: boolean; onHost?: true }) => void;
  }) => (
    <div>
      <span data-testid="branch-source">{trigger}</span>
      <button type="button" onClick={() => onSelectBase('main', { isRemoteOnly: false })}>
        Start from main
      </button>
      <button
        type="button"
        onClick={() => onSelectBase('feature/existing', { isRemoteOnly: true })}
      >
        Start from feature/existing
      </button>
      <button
        type="button"
        onClick={() => onSelectBase('host/only', { isRemoteOnly: false, onHost: true })}
      >
        Start from host/only
      </button>
      <button
        type="button"
        onClick={() => onOpenBranch('host/only', { isRemoteOnly: false, onHost: true })}
      >
        Open host/only
      </button>
      <button
        type="button"
        onClick={() => onOpenBranch('feature/existing', { isRemoteOnly: true })}
      >
        Open feature/existing
      </button>
    </div>
  ),
}));

vi.mock('../../../../src/renderer/components/projects/ProjectCreationForm', () => ({
  ProjectCreationForm: ({ initialPath }: { initialPath?: string }) => (
    <div>Project Form{initialPath && ` on ${initialPath}`}</div>
  ),
}));

vi.mock('../../../../src/renderer/components/workspaces/ActionInputDialog', () => ({
  ActionInputDialog: () => null,
}));

const mockCreateWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'ws-new' }));
const mockCreateWorkspaces = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ id: 'ws-new-1' }, { id: 'ws-new-2' }])
);
const mockSetActivePreset = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateConfig = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateProject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSyncStatus = vi.hoisted(() => ({
  value: { behindRemote: 0, isFetching: false, mainBranch: 'main' } as {
    behindRemote: number;
    aheadRemote?: number;
    isFetching: boolean;
    mainBranch: string;
  },
}));
const mockRefreshSyncStatus = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDialogPrefill = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
const mockDialogPrompt = vi.hoisted(() => ({ value: '' }));
const mockDialogAttachments = vi.hoisted(() => ({ value: [] as string[] }));
const mockSetNewWorkspaceDialogPrompt = vi.hoisted(() => vi.fn());
const mockClearNewWorkspaceDialogPrompt = vi.hoisted(() => vi.fn());
const mockRetainProvisioningWorkspacePrompt = vi.hoisted(() => vi.fn());

const mockDeleteWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSelectWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSelectedWorkspace = vi.hoisted(() => ({ id: null as string | null }));
const mockOpenNewWorkspaceDialog = vi.hoisted(() => vi.fn());
const mockWorkspaces = vi.hoisted(() => ({
  value: [{ id: 'ws-1', projectId: 'project-komla' }] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => {
  const state = () => ({
    createWorkspace: mockCreateWorkspace,
    createWorkspaces: mockCreateWorkspaces,
    deleteWorkspace: mockDeleteWorkspace,
    selectWorkspace: mockSelectWorkspace,
    workspaces: mockWorkspaces.value,
    selectedWorkspaceId: mockSelectedWorkspace.id,
  });
  return { useWorkspacesStore: Object.assign(state, { getState: state }) };
});

const mockVoiceInput = vi.hoisted(() => ({
  isRecording: false,
  isTranscribing: false,
  levels: [],
  duration: 0,
  startRecording: vi.fn(),
  stopAndTranscribe: vi.fn(),
  cancelRecording: vi.fn(),
  cancelTranscription: vi.fn(),
}));

vi.mock('../../../../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: (opts: {
    onTranscription: (text: string, target: undefined, info: { morePending: boolean }) => void;
  }) => {
    // Stash the callback so tests can invoke it
    mockVoiceInput._onTranscription = (text: string, morePending = false) =>
      opts.onTranscription(text, undefined, { morePending });
    return mockVoiceInput;
  },
}));

vi.mock('../../../../src/renderer/components/workspaces/VoiceRecordingIndicator', () => ({
  VoiceRecordingIndicator: ({
    onNavigateToSettings,
    onStartRecording,
  }: {
    onNavigateToSettings: () => void;
    onStartRecording: () => void;
  }) => (
    <>
      <button type="button" data-testid="voice-indicator" onClick={onNavigateToSettings}>
        Voice settings
      </button>
      <button type="button" onClick={onStartRecording}>
        Dictate
      </button>
    </>
  ),
}));

const mockVoiceStoreGetState = vi.hoisted(() =>
  vi.fn(() => ({
    modelStatus: 'not-downloaded' as string,
    loadModelStatus: vi.fn().mockResolvedValue(undefined),
  }))
);

vi.mock('../../../../src/renderer/stores/voice.store', () => ({
  useVoiceStore: Object.assign(() => ({ loadModels: vi.fn() }), {
    getState: mockVoiceStoreGetState,
  }),
}));

const mockPresetStore = vi.hoisted(() => ({
  activePreset: {
    id: 'preset-1',
    name: 'Codex',
    openCommand: 'codex',
    promptCommand: 'codex {{prompt}}',
    launchModes: [],
  },
  activePresets: [],
  presets: [],
  setActivePreset: mockSetActivePreset,
}));

vi.mock('../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => mockPresetStore,
}));

const mockActionsHolder = vi.hoisted(() => ({
  value: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: () => ({
    actions: mockActionsHolder.value,
    loadActions: vi.fn().mockResolvedValue(undefined),
    recordActionUsage: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockConfigHolder = vi.hoisted(() => ({
  value: {
    lastUsedProjectId: 'project-komla',
    defaultProjectId: 'project-komla',
    autoNameBranches: false,
  } as Record<string, unknown>,
}));
const mockSshHostsHolder = vi.hoisted(() => ({
  value: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../src/renderer/stores/config.store', () => {
  const state = {
    get config() {
      return mockConfigHolder.value;
    },
    updateConfig: mockUpdateConfig,
  };
  return {
    useConfigStore: Object.assign(
      (selector?: (value: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state }
    ),
  };
});

vi.mock('../../../../src/renderer/stores/ssh-hosts.store', () => ({
  useSshHostsStore: (selector: (state: { hosts: Array<Record<string, unknown>> }) => unknown) =>
    selector({ hosts: mockSshHostsHolder.value }),
}));

vi.mock('../../../../src/renderer/stores/dialogs.store', () => ({
  useDialogsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        newWorkspaceDialogPrompt: mockDialogPrompt.value,
        newWorkspaceDialogPrefill: mockDialogPrefill.value,
      }),
    {
      getState: () => ({
        newWorkspaceDialogPrompt: mockDialogPrompt.value,
        newWorkspaceDialogAttachments: mockDialogAttachments.value,
        newWorkspaceDialogPrefill: mockDialogPrefill.value,
        setNewWorkspaceDialogPrompt: mockSetNewWorkspaceDialogPrompt,
        setNewWorkspaceDialogAttachments: (attachments: string[]) => {
          mockDialogAttachments.value = attachments;
        },
        clearNewWorkspaceDialogPrompt: mockClearNewWorkspaceDialogPrompt,
        retainProvisioningWorkspacePrompt: mockRetainProvisioningWorkspacePrompt,
        setNewWorkspaceDialogPrefill: (prefill: { sshHostId?: string } | null) => {
          mockDialogPrefill.value = prefill;
        },
      }),
    }
  ),
  openNewWorkspaceDialog: mockOpenNewWorkspaceDialog,
}));

vi.mock('../../../../src/renderer/stores/project-sync-status.store', () => ({
  useProjectSyncStatusStore: Object.assign(
    () => ({
      getStatus: vi.fn(() => mockSyncStatus.value),
      refreshStatus: mockRefreshSyncStatus,
      loadAllStatuses: vi.fn().mockResolvedValue(undefined),
    }),
    { getState: () => ({ updateFromWorkspaceStatus: vi.fn() }) }
  ),
}));

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    projects: mockProjects,
    updateProject: mockUpdateProject,
  }),
}));

const mockAddToast = vi.hoisted(() => vi.fn());
const mockShowUpgradeDialog = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: Object.assign(() => ({ addToast: mockAddToast }), {
    getState: () => ({ addToast: mockAddToast }),
  }),
}));

vi.mock('../../../../src/renderer/utils/workspace-error', () => ({
  handleCreateError: vi.fn((error: Error) => error.message),
  isRunningLimitError: vi.fn(
    (error: unknown) => error instanceof Error && error.message.includes('WORKSPACE_LIMIT:')
  ),
  showUpgradeDialog: mockShowUpgradeDialog,
}));

describe('NewWorkspaceDialog', () => {
  // A launch's Undo falls back to its toast after a moment, which would land in the next test.
  afterEach(() => dismissLaunchUndo());

  beforeEach(() => {
    vi.clearAllMocks();
    seedShortcuts();
    mockSetActivePreset.mockResolvedValue(undefined);
    mockConfigHolder.value = {
      lastUsedProjectId: 'project-komla',
      defaultProjectId: 'project-komla',
      autoNameBranches: false,
    };
    mockSshHostsHolder.value = [];
    mockPresetStore.activePreset = {
      id: 'preset-1',
      name: 'Codex',
      openCommand: 'codex',
      promptCommand: 'codex {{prompt}}',
      launchModes: [],
    };
    mockPresetStore.activePresets = [];
    mockPresetStore.presets = [];
    mockVoiceInput.isRecording = false;
    mockVoiceInput.isTranscribing = false;
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new' });
    mockCreateWorkspaces.mockResolvedValue([{ id: 'ws-new-1' }, { id: 'ws-new-2' }]);
    mockProjects[0].managed = false;
    mockProjects[0].sshWorkspaceMode = undefined;
    mockProjects[1].managed = false;
    mockSyncStatus.value = { behindRemote: 0, isFetching: false, mainBranch: 'main' };
    mockRefreshSyncStatus.mockResolvedValue(undefined);
    mockDialogPrefill.value = null;
    mockDialogPrompt.value = '';
    mockDialogAttachments.value = [];
    mockActionsHolder.value = [];
    mockSelectedWorkspace.id = null;
    mockWorkspaces.value = [{ id: 'ws-1', projectId: 'project-komla' }];
    global.window.api = {
      getWorktreeBranches: vi.fn().mockResolvedValue([]),
      getDirectoryInfo: vi.fn().mockResolvedValue(null),
      findProjectForFolder: vi.fn().mockResolvedValue({ project: null, repoRoot: null }),
      recordOpenedFolder: vi.fn().mockResolvedValue(undefined),
      getMainBranch: vi.fn().mockResolvedValue('main'),
      selectAnyDirectory: vi.fn().mockResolvedValue('/plain/folder'),
      voiceGetModelStatus: vi.fn().mockResolvedValue('not-downloaded'),
      voiceSetRecordingState: vi.fn().mockResolvedValue(undefined),
      verifySshHost: vi.fn().mockResolvedValue({
        ok: true,
        prepared: false,
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        localMirror: {
          platform: 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        tmux: { status: 'available' },
        gitIdentity: { configured: true },
      }),
    } as any;
  });

  describe('prompt attachments', () => {
    // A paste or drop as Chromium reports it: `path` is where the file is on disk, if anywhere.
    // An `unflaggedFolder` is a folder Chromium doesn't mark as one, so only reading it fails.
    const transfer = (
      entries: Array<{
        name: string;
        type?: string;
        path?: string;
        isDirectory?: boolean;
        unflaggedFolder?: boolean;
      }>,
      text?: string
    ) => {
      const files = entries.map(({ name, type = '', unflaggedFolder }) => {
        const file = new File(['x'], name, { type });
        if (unflaggedFolder) {
          file.slice = () =>
            ({ arrayBuffer: () => Promise.reject(new DOMException('', 'NotFoundError')) }) as Blob;
        }
        return file;
      });
      window.api.getPathForFile = vi.fn(
        (file: File) => entries[files.indexOf(file)]?.path ?? ''
      ) as any;
      return {
        files,
        types: [...(text === undefined ? [] : ['text/plain']), ...(files.length ? ['Files'] : [])],
        items: files.map((file, i) => ({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
          webkitGetAsEntry: () =>
            entries[i].unflaggedFolder ? null : { isDirectory: !!entries[i].isDirectory },
        })),
        getData: () => text ?? '',
      };
    };
    const attachmentNames = () =>
      within(screen.queryByRole('list', { name: 'Attachments' }) ?? document.createElement('ul'))
        .queryAllByRole('listitem')
        .map((item) => item.querySelector('[title]')?.textContent);

    it('attaches pasted files and launches with them', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, 'Fix the layout');

      fireEvent.paste(textarea, {
        clipboardData: transfer(
          [{ name: 'shot.png', type: 'image/png', path: '/Users/me/shot.png' }],
          'shot.png'
        ),
      });

      await waitFor(() => expect(attachmentNames()).toEqual(['shot.png']));
      expect(textarea).toHaveValue('Fix the layout');
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            initialPrompt: 'Fix the layout',
            attachments: ['/Users/me/shot.png'],
          })
        )
      );
    });

    it('saves a pasted screenshot and attaches it', async () => {
      window.api.stageClipboardImage = vi
        .fn()
        .mockResolvedValue('/tmp/staged/1/clipboard-image-1.png');
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.paste(textarea, {
        clipboardData: transfer([{ name: 'image.png', type: 'image/png' }]),
      });

      await waitFor(() => expect(attachmentNames()).toEqual(['clipboard-image-1.png']));
    });

    it('pastes the text when the clipboard holds text and an image', async () => {
      window.api.stageClipboardImage = vi.fn();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      const notPrevented = fireEvent.paste(textarea, {
        clipboardData: transfer([{ name: 'image.png', type: 'image/png' }], 'A1\tB1'),
      });

      expect(notPrevented).toBe(true);
      expect(window.api.stageClipboardImage).not.toHaveBeenCalled();
      expect(attachmentNames()).toEqual([]);
    });

    it('attaches dropped files but not folders, and removes one on request', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.drop(textarea, {
        dataTransfer: transfer([
          { name: 'spec.pdf', path: '/docs/spec.pdf' },
          { name: 'src', path: '/repo/src', isDirectory: true },
          { name: 'log.txt', path: 'C:\\logs\\log.txt' },
        ]),
      });

      await waitFor(() => expect(attachmentNames()).toEqual(['spec.pdf', 'log.txt']));
      await user.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));
      expect(attachmentNames()).toEqual(['log.txt']);
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ attachments: ['C:\\logs\\log.txt'] })
        )
      );
    });

    it('takes files dropped anywhere in the window, showing where they go while dragging', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      const dataTransfer = transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]);

      fireEvent.dragEnter(document.body, { dataTransfer });
      expect(screen.getByText('Drop to attach')).toBeInTheDocument();
      // Crossing into a child element and back keeps the overlay up.
      fireEvent.dragEnter(getLaunchButton(), { dataTransfer });
      fireEvent.dragLeave(getLaunchButton(), { dataTransfer });
      expect(screen.getByText('Drop to attach')).toBeInTheDocument();
      fireEvent.drop(document.body, { dataTransfer });

      expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument();
      await waitFor(() => expect(attachmentNames()).toEqual(['spec.pdf']));
    });

    it('leaves a pasted folder out even when Chromium does not flag it as one', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.paste(textarea, {
        clipboardData: transfer([
          { name: 'src', path: '/repo/src', unflaggedFolder: true },
          { name: 'spec.pdf', path: '/docs/spec.pdf' },
        ]),
      });

      await waitFor(() => expect(attachmentNames()).toEqual(['spec.pdf']));
    });

    it('leaves a drop alone when something under the pointer already took it', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      const dropZone = document.createElement('div');
      dropZone.addEventListener('drop', (e) => e.preventDefault());
      document.body.appendChild(dropZone);

      fireEvent.drop(dropZone, {
        dataTransfer: transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]),
      });
      await act(async () => {});

      expect(attachmentNames()).toEqual([]);
      dropZone.remove();
    });

    it('hides the drop overlay when the drag leaves the window', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      const dataTransfer = transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]);

      fireEvent.dragEnter(document.body, { dataTransfer });
      fireEvent.dragLeave(document.body, { dataTransfer });

      expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument();
    });

    it('ignores file drops once the dialog closes', async () => {
      const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      rerender(<NewWorkspaceDialog open={false} onOpenChange={vi.fn()} />);

      const notPrevented = fireEvent.drop(document.body, {
        dataTransfer: transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]),
      });

      expect(notPrevented).toBe(true);
    });

    it('launches without attachments when none were added', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      expect(mockCreateWorkspace.mock.calls[0][0]).not.toHaveProperty('attachments');
    });

    it('keeps the attachments of a launch that fails for the next open', async () => {
      const user = userEvent.setup();
      mockCreateWorkspace.mockRejectedValueOnce(new Error("Couldn't attach spec.pdf: gone"));
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      fireEvent.drop(textarea, {
        dataTransfer: transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]),
      });

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      expect(mockDialogAttachments.value).toEqual(['/docs/spec.pdf']);
    });

    it('forgets the attachments once the launch succeeds', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      fireEvent.drop(textarea, {
        dataTransfer: transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]),
      });

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      await waitFor(() => expect(mockDialogAttachments.value).toEqual([]));
    });

    it('keeps attachments when the dialog closes and brings them back on reopen', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      fireEvent.drop(textarea, {
        dataTransfer: transfer([{ name: 'spec.pdf', path: '/docs/spec.pdf' }]),
      });

      // Opening Voice settings closes the dialog the way a user does.
      await user.click(screen.getByRole('button', { name: 'Voice settings…' }));
      expect(mockDialogAttachments.value).toEqual(['/docs/spec.pdf']);
      unmount();

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await waitFor(() => expect(attachmentNames()).toEqual(['spec.pdf']));
      expect(mockDialogAttachments.value).toEqual([]);
    });
  });

  it('shows a retained provisioning prompt when failure arrives while open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

    expect(textarea).toHaveValue('');

    mockDialogPrompt.value = 'Retry the remote setup';
    rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => expect(textarea).toHaveValue('Retry the remote setup'));

    await user.clear(textarea);
    expect(textarea).toHaveValue('');
  });

  it('does not replace a newer draft when a retained provisioning prompt arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(textarea, 'Use a different environment');

    mockDialogPrompt.value = 'Retry the remote setup';
    rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    expect(textarea).toHaveValue('Use a different environment');
  });

  describe('project choice and undoing a launch', () => {
    const flashingProject = () => document.querySelector('.animate-project-attention');
    const makeDraft = (overrides: Record<string, unknown> = {}) => ({
      prompt: 'Fix the toast',
      attachments: [],
      projectId: 'project-empty',
      branchMode: 'new',
      branchName: 'fix-toast',
      isBranchNameAutoGenerated: false,
      existingBranch: '',
      existingBranchIsRemote: false,
      branchHostId: '',
      baseBranch: 'develop',
      launchTarget: 'local',
      sshHostId: '',
      actionId: '',
      presetId: null,
      launchModeId: null,
      reasoningLevelOverrides: {},
      launchTargets: [],
      aiBranchNameOverride: null,
      sourceWorkspaceId: '',
      ...overrides,
    });
    const clickUndo = () => {
      const undoCall = mockAddToast.mock.calls.find(([, , options]) => options?.quiet);
      act(() => undoCall![2].action.onClick());
    };

    it('starts in the last-used project and flashes it when another workspace is selected', async () => {
      const user = userEvent.setup();
      mockSelectedWorkspace.id = 'ws-1'; // in project-komla
      mockConfigHolder.value = {
        lastUsedProjectId: 'project-empty',
        defaultProjectId: null,
        autoNameBranches: false,
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => expect(flashingProject()).toHaveTextContent('Empty Prefix Project'));
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-empty' })
        )
      );
    });

    it('does not flash the selected workspace’s own project', async () => {
      mockSelectedWorkspace.id = 'ws-1';

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByPlaceholderText('komla/swift-fox');
      expect(flashingProject()).toBeNull();
    });

    it('offers Undo in a toast when no row shows it, which deletes the workspace and reopens the dialog', async () => {
      const user = userEvent.setup();
      mockSelectedWorkspace.id = 'ws-1';
      mockCreateWorkspace.mockResolvedValue({
        id: 'ws-new',
        name: 'swift-fox',
        projectId: 'project-komla',
      });

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, 'Fix the toast');
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockAddToast).toHaveBeenCalledWith(
          'Workspace created in Komla Project',
          'success',
          expect.objectContaining({
            quiet: true,
            action: expect.objectContaining({ label: 'Undo' }),
          })
        )
      );
      // The new workspace took the focus.
      mockSelectedWorkspace.id = 'ws-new';
      clickUndo();

      expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws-new', true, true, expect.any(Function));
      expect(mockSelectWorkspace).toHaveBeenCalledWith('ws-1');
      expect(mockOpenNewWorkspaceDialog).toHaveBeenCalledWith({
        prefill: {
          draft: expect.objectContaining({
            prompt: 'Fix the toast',
            projectId: 'project-komla',
            branchMode: 'new',
            branchName: 'komla/swift-fox',
          }),
        },
      });
    });

    it('restores an undone launch’s choices instead of the defaults', async () => {
      const user = userEvent.setup();
      mockDialogPrefill.value = { draft: makeDraft() };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      expect(await screen.findByPlaceholderText(/what should the agent work on/i)).toHaveValue(
        'Fix the toast'
      );
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-empty',
            branchName: 'fix-toast',
            baseBranch: 'develop',
            initialPrompt: 'Fix the toast',
          })
        )
      );
    });

    it('brings back an undone launch’s attachments', async () => {
      const user = userEvent.setup();
      mockDialogPrefill.value = { draft: makeDraft({ attachments: ['/docs/spec.pdf'] }) };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByRole('button', { name: 'Remove spec.pdf' });
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ attachments: ['/docs/spec.pdf'] })
        )
      );
    });

    it('keeps the restored prompt over one saved since the launch', async () => {
      mockDialogPrompt.value = 'A newer idea';
      mockDialogPrefill.value = { draft: makeDraft() };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await waitFor(() => expect(textarea).toHaveValue('Fix the toast'));
    });

    it('keeps a prompt being written when Undo arrives while the dialog is open', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, 'Something else');

      mockDialogPrefill.value = { draft: makeDraft() };
      rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => expect(mockDialogPrefill.value).toBeNull());
      expect(textarea).toHaveValue('Something else');
    });

    it('brings an existing-branch launch back only once its worktree is deleted', async () => {
      const user = userEvent.setup();
      mockDialogPrefill.value = {
        draft: makeDraft({
          projectId: 'project-komla',
          branchMode: 'existing',
          branchName: '',
          existingBranch: 'feature/existing',
          baseBranch: '',
        }),
      };
      mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', projectId: 'project-komla' });

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ branchName: 'feature/existing', checkoutExistingBranch: true })
        )
      );
      await waitFor(() => expect(mockAddToast).toHaveBeenCalled());
      clickUndo();

      // The branch stays; the dialog waits for the delete.
      expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws-new', true, false, expect.any(Function));
      expect(mockOpenNewWorkspaceDialog).not.toHaveBeenCalled();
      act(() => mockDeleteWorkspace.mock.calls[0][3]());
      expect(mockOpenNewWorkspaceDialog).toHaveBeenCalledWith({
        prefill: {
          draft: expect.objectContaining({
            branchMode: 'existing',
            existingBranch: 'feature/existing',
          }),
        },
      });
    });

    it('does not offer Undo for a folder opened as a workspace', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: /^open folder…$/i }));

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ directoryPath: '/plain/folder' })
        )
      );
      expect(mockAddToast).not.toHaveBeenCalled();
    });
  });

  it('regenerates an auto-generated branch when switching to a project without a prefix', async () => {
    const user = userEvent.setup();

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
    await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

    await user.click(screen.getByRole('button', { name: /empty prefix project/i }));

    await waitFor(() => {
      expect(branchInput).toHaveValue('swift-fox');
      expect(branchInput).toHaveAttribute('placeholder', 'swift-fox');
    });
  });

  it('uses a non-modal project picker inside the workspace dialog', async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const [projectPicker] = await screen.findAllByRole('button', { name: /Komla Project/i });

    expect(projectPicker.closest('[data-modal]')).toHaveAttribute('data-modal', 'false');
  });

  it('keeps the branch name empty while the user replaces the generated name', async () => {
    const user = userEvent.setup();

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
    await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

    await user.clear(branchInput);
    expect(branchInput).toHaveValue('');

    await user.type(branchInput, 'custom-branch');
    expect(branchInput).toHaveValue('custom-branch');
  });

  it('persists agent preset changes without creating a workspace', async () => {
    const user = userEvent.setup();
    mockConfigHolder.value = {
      ...mockConfigHolder.value,
      defaultLaunchModeId: 'mode-1',
    };
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Default Sandbox', command: 'codex --sandbox' }],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [{ id: 'mode-2', name: 'Claude Plan', command: 'claude --plan' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByTitle(/click to select agent and launch mode/i));
    await user.hover(screen.getByRole('button', { name: /show claude code launch modes/i }));
    await user.click(screen.getByRole('button', { name: /^Claude Code, Claude Plan$/i }));

    expect(mockSetActivePreset).toHaveBeenCalledWith('preset-2', 'mode-2');
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTitle(/click to select agent and launch mode/i)).toHaveTextContent(
        'Claude Code Claude Plan'
      );
    });
    const pill = screen.getByTitle(/click to select agent and launch mode/i);
    expect(within(pill).getByText('Claude Plan')).toHaveClass('bg-blue-500/15');
    expect(pill).not.toHaveClass('bg-blue-500/15');
  });

  it('uses a compact launch-mode-only picker for a single preset', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Sandbox', command: 'codex --sandbox' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    const picker = screen.getByTitle('Click to select launch mode, Shift+Tab cycles launch modes');
    await user.click(picker);

    const matrix = document.querySelector('[data-agent-launch-matrix]');
    expect(matrix).toHaveAttribute('data-agent-launch-layout', 'compact');
    expect(matrix?.closest('[data-dropdown-content]')).toHaveClass(
      'w-max',
      'min-w-[min(18rem,calc(100vw-2rem))]',
      'max-w-[min(22rem,calc(100vw-2rem))]'
    );
    expect(
      screen.queryByRole('button', { name: /show codex launch modes/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Codex, Default$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Codex, Sandbox$/i })).toBeInTheDocument();
    expect(screen.getByText(/cycle launch mode/)).toHaveTextContent('Shift+Tab cycle launch mode');
    expect(screen.getByText('Shift+Tab', { selector: 'kbd' })).toBeInTheDocument();
    expect(screen.queryByText(/cycle agent/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage agents…' })).toBeInTheDocument();
  });

  it('opens Settings → Agents from the agent picker, keeping the prompt', async () => {
    useSettingsDialogStore.setState({ open: false, target: {} });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);

    await user.type(
      await screen.findByPlaceholderText(/what should the agent work on/i),
      'Fix the login bug'
    );
    await user.click(screen.getByTitle(/click to select agent and launch mode/i));
    await user.click(screen.getByRole('button', { name: 'Manage agents…' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSetNewWorkspaceDialogPrompt).toHaveBeenCalledWith('Fix the login bug');
    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'agent' },
    });
  });

  it('preselects and applies the hovered preset last-used launch mode', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Codex Mode', command: 'codex --mode' }],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [
          { id: 'mode-2', name: 'Claude Plan', command: 'claude --plan' },
          { id: 'mode-3', name: 'Claude Auto', command: 'claude --auto' },
        ],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200, lastLaunchModeId: 'mode-1' },
      { presetId: 'preset-2', lastUsedAt: 100, lastLaunchModeId: 'mode-3' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByTitle(/click to select agent and launch mode/i));
    const claudePreset = screen.getByRole('button', {
      name: /show claude code launch modes/i,
    });

    await user.hover(claudePreset);
    expect(screen.getByRole('button', { name: /^Claude Code, Claude Auto$/i })).toHaveClass(
      'bg-foreground/8'
    );

    await user.click(claudePreset);

    expect(mockSetActivePreset).toHaveBeenCalledWith('preset-2', 'mode-3');
    expect(screen.getByTitle(/click to select agent and launch mode/i)).toHaveTextContent(
      'Claude Code Claude Auto'
    );
  });

  it('reopens with the currently selected agent preselected', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Codex Mode', command: 'codex --mode' }],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [
          { id: 'mode-2', name: 'Claude Plan', command: 'claude --plan' },
          { id: 'mode-3', name: 'Claude Accept', command: 'claude --accept' },
          { id: 'mode-4', name: 'Claude Auto', command: 'claude --auto' },
        ],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    const picker = screen.getByTitle(/click to select agent and launch mode/i);
    const codexAgent = screen.getByRole('button', { name: /show codex launch modes/i });
    const claudeAgent = screen.getByRole('button', {
      name: /show claude code launch modes/i,
    });

    await user.click(picker);
    expect(codexAgent).toHaveClass('bg-foreground/8');
    const matrix = screen
      .getByRole('button', { name: /^Codex, Codex Mode$/i })
      .closest('[data-agent-launch-matrix]');
    expect(matrix).toHaveAttribute('data-agent-launch-layout', 'matrix');
    expect(matrix).toHaveStyle({ minHeight: '8.375rem' });
    expect(screen.queryByText(/^Launch mode$/i)).not.toBeInTheDocument();

    await user.hover(claudeAgent);
    expect(claudeAgent).toHaveClass('bg-foreground/8');
    expect(screen.getByRole('button', { name: /^Claude Code, Claude Plan$/i })).toBeInTheDocument();
    expect(matrix).toHaveStyle({ minHeight: '8.375rem' });

    await user.click(picker);
    await user.click(picker);

    expect(codexAgent).toHaveClass('bg-foreground/8');
    expect(screen.getByRole('button', { name: /^Codex, Codex Mode$/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Claude Code, Claude Plan$/i })
    ).not.toBeInTheDocument();
  });

  it('launches one workspace per selected agent with the same task', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [
          {
            id: 'mode-1',
            name: 'Sandbox',
            command: 'codex --sandbox',
            color: 'purple',
          },
        ],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    const onDialogOpenChange = vi.fn();
    render(<NewWorkspaceDialog open={true} onOpenChange={onDialogOpenChange} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Compare implementations');
    const presetPicker = screen.getByTitle(/click to select agent/i);
    expect(presetPicker.closest('[data-modal]')).toHaveAttribute('data-modal', 'false');
    await user.click(presetPicker);
    expect(
      screen.getByRole('button', { name: /^Codex, Default$/i }).closest('[data-dropdown-content]')
    ).toHaveClass('max-h-[var(--radix-dropdown-menu-content-available-height)]');
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    const codexDefault = screen.getByRole('checkbox', { name: /^Codex, Default$/i });
    expect(codexDefault).not.toBeChecked();
    expect(codexDefault.querySelector('[data-launch-mode-color]')).toHaveAttribute(
      'data-launch-mode-color',
      'default'
    );
    expect(
      screen
        .getByRole('checkbox', { name: /^Codex, Sandbox$/i })
        .querySelector('[data-launch-mode-color]')
    ).toHaveAttribute('data-launch-mode-color', 'purple');
    expect(screen.queryByRole('button', { name: /^Codex, Default$/i })).not.toBeInTheDocument();
    await user.click(codexDefault);

    expect(presetPicker).toBeInTheDocument();
    expect(presetPicker).toHaveAttribute('title', 'Edit parallel workspace selection');
    expect(codexDefault).toBeChecked();

    await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
    const claudeDefault = screen.getByRole('checkbox', { name: /^Claude Code, Default$/i });
    expect(claudeDefault).not.toBeChecked();
    await user.click(claudeDefault);
    expect(claudeDefault).toBeChecked();

    expect(presetPicker).toHaveTextContent('2 parallel workspaces');
    expect(presetPicker).toHaveAttribute('title', 'Edit parallel workspace selection');
    expect(presetPicker.closest('[data-modal]')).toHaveAttribute('data-modal', 'false');
    expect(getLaunchButton()).toHaveTextContent('Launch 2 ↵');

    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspaces).toHaveBeenCalledTimes(1));
    const createParams = mockCreateWorkspaces.mock.calls[0][0];
    expect(createParams.map((params: { presetId: string }) => params.presetId)).toEqual([
      'preset-1',
      'preset-2',
    ]);
    for (const params of createParams) {
      expect(params).toEqual(
        expect.objectContaining({
          initialPrompt: 'Compare implementations',
          branchName: 'komla/swift-fox',
          autoResolveBranchConflicts: true,
        })
      );
    }
  });

  describe('agents from a prefill', () => {
    beforeEach(() => {
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-2',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-3',
          name: 'Cursor CLI',
          openCommand: 'cursor-agent',
          promptCommand: 'cursor-agent {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-4',
          name: 'Pi',
          openCommand: 'pi',
          promptCommand: 'pi {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = mockPresetStore.presets.map((preset, index) => ({
        presetId: preset.id,
        lastUsedAt: 400 - index,
      }));
    });

    it('starts with the agents it asks for, one workspace each', async () => {
      const user = userEvent.setup();
      const onLaunch = vi.fn();
      mockDialogPrefill.value = { presetIds: ['preset-3', 'preset-4'], onLaunch };
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByPlaceholderText(/what should the agent work on/i);
      expect(screen.getByTitle('Edit parallel workspace selection')).toHaveTextContent(
        '2 parallel workspaces'
      );
      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspaces).toHaveBeenCalledTimes(1));
      expect(
        mockCreateWorkspaces.mock.calls[0][0].map((params: { presetId: string }) => params.presetId)
      ).toEqual(['preset-3', 'preset-4']);
      await waitFor(() => expect(onLaunch).toHaveBeenCalledWith(['preset-3', 'preset-4']));
    });

    it('says it started only the first agent where a launch starts one', async () => {
      const user = userEvent.setup();
      const onLaunch = vi.fn();
      mockProjects.unshift({
        id: 'project-folder',
        name: 'Plain Folder',
        kind: 'directory',
        repositoryPath: '/plain/folder',
      });
      // Closes like the app does, before the workspace is created.
      function ClosingDialog() {
        const [open, setOpen] = React.useState(true);
        return <NewWorkspaceDialog open={open} onOpenChange={setOpen} />;
      }
      try {
        mockDialogPrefill.value = {
          projectId: 'project-folder',
          presetIds: ['preset-3', 'preset-4'],
          onLaunch,
        };
        render(<ClosingDialog />);

        await screen.findByPlaceholderText(/what should the agent work on/i);
        await user.click(getLaunchButton());

        await waitFor(() =>
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'directory', presetId: 'preset-3' })
          )
        );
        await waitFor(() => expect(onLaunch).toHaveBeenCalledWith(['preset-3']));
      } finally {
        mockProjects.shift();
      }
    });

    // The app renders in StrictMode, which runs mount effects twice in dev builds.
    it('keeps the agents it asks for when mount effects run twice', async () => {
      mockDialogPrefill.value = { presetIds: ['preset-3', 'preset-4'] };
      render(
        <React.StrictMode>
          <NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />
        </React.StrictMode>
      );

      await screen.findByPlaceholderText(/what should the agent work on/i);
      expect(screen.getByTitle('Edit parallel workspace selection')).toHaveTextContent(
        '2 parallel workspaces'
      );
    });

    it('starts with the one agent it asks for instead of the last used', async () => {
      mockDialogPrefill.value = { presetIds: ['preset-4'] };
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByPlaceholderText(/what should the agent work on/i);
      expect(screen.getByTitle(/click to select agent and launch mode/i)).toHaveTextContent('Pi');
    });
  });

  it('discards draft targets and can return a saved batch to one agent', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText(/what should the agent work on/i);
    const picker = screen.getByTitle(/click to select agent/i);
    await user.click(picker);
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Codex, Default$/i }));
    expect(screen.getByRole('button', { name: /done · 1 selected/i })).toBeEnabled();
    expect(picker).toHaveTextContent('1 parallel workspace');
    expect(screen.getByTitle('Edit parallel workspace selection')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(picker).toHaveTextContent(/^Codex$/);
    expect(picker).toHaveAttribute('title', expect.stringMatching(/click to select agent/i));

    await user.click(picker);
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Codex, Default$/i }));
    await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i }));
    await user.click(screen.getByRole('button', { name: /done · 2 selected/i }));

    expect(picker).toHaveTextContent('2 parallel workspaces');
    await user.click(picker);
    await user.click(screen.getByRole('button', { name: /use one agent/i }));

    expect(picker).toHaveTextContent(/^Codex$/);
    expect(getLaunchButton()).toHaveTextContent('Launch ↵');
  });

  it('uses one multi-select target as the normal selection on done or close', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText(/what should the agent work on/i);
    const picker = screen.getByTitle(/click to select agent/i);
    await user.click(picker);
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i }));
    await user.click(screen.getByRole('button', { name: /done · 1 selected/i }));

    expect(picker).toHaveTextContent(/^Claude Code$/);
    expect(picker).toHaveAttribute('title', expect.stringMatching(/click to select agent/i));
    expect(getLaunchButton()).toHaveTextContent('Launch ↵');

    await user.click(picker);
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    await user.click(screen.getByRole('button', { name: /show codex launch modes/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Codex, Default$/i }));
    await user.click(picker);

    expect(picker).toHaveTextContent(/^Codex$/);
    expect(picker).toHaveAttribute('title', expect.stringMatching(/click to select agent/i));
    expect(getLaunchButton()).toHaveTextContent('Launch ↵');
  });

  it('excludes Shell Only from multi-agent launch targets', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      { id: 'shell-only', name: 'Shell Only', openCommand: '', launchModes: [] },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 300 },
      { presetId: 'shell-only', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.click(screen.getByTitle(/click to select agent/i));
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));

    expect(
      screen.queryByRole('button', { name: /show shell only launch modes/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^Codex, Default$/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
    expect(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i })).toBeInTheDocument();
  });

  it('contains wheel gestures while switching the existing picker to multi-select', async () => {
    const user = userEvent.setup();
    const escapedWheel = vi.fn();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];
    document.addEventListener('wheel', escapedWheel);

    try {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByPlaceholderText(/what should the agent work on/i);
      const presetPicker = screen.getByTitle(/click to select agent/i);
      await user.click(presetPicker);
      fireEvent.wheel(screen.getByRole('button', { name: /^Codex, Default$/i }), {
        deltaX: 1,
        deltaY: 12,
      });
      expect(escapedWheel).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
      const codexDefault = screen.getByRole('checkbox', { name: /^Codex, Default$/i });

      fireEvent.wheel(codexDefault, { deltaX: 1, deltaY: 12 });
      expect(escapedWheel).not.toHaveBeenCalled();

      await user.click(codexDefault);
      await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
      await user.click(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i }));
      await user.click(screen.getByRole('button', { name: /done · 2 selected/i }));
      expect(screen.getByTitle('Edit parallel workspace selection')).toBeInTheDocument();

      fireEvent.wheel(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i }), {
        deltaX: 1,
        deltaY: 12,
      });
      expect(escapedWheel).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('wheel', escapedWheel);
    }
  });

  it('opens the multi-stop upgrade flow and retries the preserved batch', async () => {
    const user = userEvent.setup();
    mockCreateWorkspaces.mockRejectedValue(
      new Error('WORKSPACE_LIMIT: Not enough room for the complete batch.')
    );
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    const onDialogOpenChange = vi.fn();
    render(<NewWorkspaceDialog open={true} onOpenChange={onDialogOpenChange} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Compare implementations');
    const presetPicker = screen.getByTitle(/click to select agent/i);
    await user.click(presetPicker);
    await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Codex, Default$/i }));
    await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Claude Code, Default$/i }));
    await user.click(screen.getByRole('button', { name: /done · 2 selected/i }));
    await user.click(getLaunchButton());

    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    expect(mockCreateWorkspaces).toHaveBeenCalledTimes(1);
    expect(onDialogOpenChange).not.toHaveBeenCalled();
    expect(prompt).toHaveValue('Compare implementations');
    expect(mockShowUpgradeDialog).toHaveBeenCalledWith(expect.any(Function), 2);

    mockCreateWorkspaces.mockResolvedValue([{ id: 'ws-new-1' }, { id: 'ws-new-2' }]);
    const retry = mockShowUpgradeDialog.mock.calls[0][0] as () => void;
    retry();

    await waitFor(() => expect(mockCreateWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onDialogOpenChange).toHaveBeenCalledWith(false));
  });

  it('retains the submitted prompt when workspace creation fails', async () => {
    const user = userEvent.setup();
    mockCreateWorkspace.mockRejectedValueOnce(new Error('SSH host unavailable'));

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Investigate the remote build');
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledTimes(1));
    expect(mockSetNewWorkspaceDialogPrompt).toHaveBeenCalledWith('Investigate the remote build');
    expect(mockClearNewWorkspaceDialogPrompt).not.toHaveBeenCalled();
  });

  it('holds the submitted prompt until provisioning finishes', async () => {
    const user = userEvent.setup();
    mockCreateWorkspace.mockResolvedValueOnce({
      id: 'ws-provisioning',
      provisioning: true,
    });

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Investigate the remote build');
    await user.click(getLaunchButton());

    await waitFor(() =>
      expect(mockRetainProvisioningWorkspacePrompt).toHaveBeenCalledWith(
        'ws-provisioning',
        'Investigate the remote build'
      )
    );
    expect(mockClearNewWorkspaceDialogPrompt).not.toHaveBeenCalled();
  });

  it('keeps the prompt when provisioning already failed during creation', async () => {
    const user = userEvent.setup();
    mockCreateWorkspace.mockResolvedValueOnce({
      id: 'ws-failed',
      provisioning: false,
      provisionError: 'Connection refused',
    });

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Investigate the remote build');
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledTimes(1));
    expect(mockSetNewWorkspaceDialogPrompt).toHaveBeenCalledWith('Investigate the remote build');
    expect(mockRetainProvisioningWorkspacePrompt).not.toHaveBeenCalled();
    expect(mockClearNewWorkspaceDialogPrompt).not.toHaveBeenCalled();
  });

  it('clears the submitted prompt after successful creation', async () => {
    const user = userEvent.setup();

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const prompt = await screen.findByPlaceholderText(/what should the agent work on/i);
    await user.type(prompt, 'Investigate the remote build');
    await user.click(getLaunchButton());

    await waitFor(() =>
      expect(mockClearNewWorkspaceDialogPrompt).toHaveBeenCalledWith('Investigate the remote build')
    );
  });

  it('uses the non-git folder picker for unscoped directory workspaces', async () => {
    const user = userEvent.setup();

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^open folder…$/i }));

    await waitFor(() => {
      expect(window.api.selectAnyDirectory).toHaveBeenCalled();
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'directory',
          directoryPath: '/plain/folder',
        })
      );
    });
  });

  it('asks before opening a Git repository without a project, offering to add it', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.findProjectForFolder).mockResolvedValue({
      project: null,
      repoRoot: '/plain',
    });

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^open folder…$/i }));

    await waitFor(() => expect(useOpenFolderStore.getState().open).toBe(true));
    expect(useOpenFolderStore.getState().folder).toBe('/plain/folder');
    act(() => useOpenFolderStore.getState().answer('project'));

    expect(await screen.findByText('Project Form on /plain')).toBeInTheDocument();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('selects the project a picked folder already is', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.findProjectForFolder).mockResolvedValue({
      project: mockProjects[1],
      repoRoot: null,
    });

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^open folder…$/i }));

    await waitFor(() => expect(window.api.findProjectForFolder).toHaveBeenCalled());
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    await user.click(getLaunchButton());
    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-empty' })
      )
    );
  });

  it('closes the add-project form when a prefill asks for an existing project', async () => {
    const user = userEvent.setup();
    mockDialogPrefill.value = { addProjectPath: '/repos/new' };
    const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Project Form on /repos/new')).toBeInTheDocument();

    mockDialogPrefill.value = { projectId: 'project-empty' };
    rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => expect(screen.queryByText(/^Project Form/)).not.toBeInTheDocument());
    await user.click(getLaunchButton());
    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-empty' })
      )
    );
  });

  it('names new branches with the app-wide prefix in a project without one', async () => {
    const user = userEvent.setup();
    mockConfigHolder.value = {
      lastUsedProjectId: 'project-empty',
      defaultProjectId: 'project-empty',
      autoNameBranches: false,
      gitDefaults: { branchPrefix: 'me/' },
    };
    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    expect(await screen.findByPlaceholderText('me/swift-fox')).toBeInTheDocument();
    await user.click(getLaunchButton());
    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-empty', branchName: 'me/swift-fox' })
      )
    );
  });

  it('opens on the add-project form for a folder passed in the prefill', async () => {
    mockDialogPrefill.value = { addProjectPath: '/repos/new' };

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    expect(await screen.findByText('Project Form on /repos/new')).toBeInTheDocument();
  });

  it('does not warn about the target branch when opening an existing branch', async () => {
    const user = userEvent.setup();
    mockProjects[0].managed = true;
    mockSyncStatus.value = { behindRemote: 3, isFetching: false, mainBranch: 'main' };

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Open feature/existing' }));

    expect(await screen.findByText('feature/existing')).toBeInTheDocument();
    expect(screen.queryByText(/behind (remote|origin)/i)).not.toBeInTheDocument();
  });

  it('notes that a new branch starts behind origin when the target has unpushed commits', async () => {
    mockProjects[0].managed = true;
    mockSyncStatus.value = {
      behindRemote: 3,
      aheadRemote: 1,
      isFetching: false,
      mainBranch: 'main',
    };

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    expect(
      await screen.findByText(
        'main has 1 unpushed commit, so this workspace starts from local main, 3 commits behind origin'
      )
    ).toBeInTheDocument();
    // Moving main to origin would drop the unpushed commit, so nothing is offered.
    expect(screen.queryByRole('button', { name: /^Sync$/i })).not.toBeInTheDocument();
  });

  it('does not note the target branch when starting from another branch', async () => {
    const user = userEvent.setup();
    mockProjects[0].managed = true;
    mockSyncStatus.value = {
      behindRemote: 3,
      aheadRemote: 1,
      isFetching: false,
      mainBranch: 'main',
    };

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/3 commits behind origin/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start from feature/existing' }));

    expect(screen.queryByText(/behind origin/)).not.toBeInTheDocument();
  });

  it('hides local project sync status when launching on an SSH host', async () => {
    mockProjects[0].managed = true;
    mockSyncStatus.value = {
      behindRemote: 3,
      aheadRemote: 1,
      isFetching: false,
      mainBranch: 'main',
    };
    mockConfigHolder.value = {
      ...mockConfigHolder.value,
      lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
    };
    mockSshHostsHolder.value = [
      { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /Build Server/i })).toBeInTheDocument();
    expect(screen.queryByText(/behind (remote|origin)/i)).not.toBeInTheDocument();
  });

  it('cycles through every active preset even as last-used timestamps change', async () => {
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-3',
        name: 'OpenCode',
        openCommand: 'opencode',
        promptCommand: 'opencode {{prompt}}',
        launchModes: [],
      },
      {
        id: 'preset-4',
        name: 'Gemini',
        openCommand: 'gemini',
        promptCommand: 'gemini {{prompt}}',
        launchModes: [],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 400 },
      { presetId: 'preset-2', lastUsedAt: 300 },
      { presetId: 'preset-3', lastUsedAt: 200 },
      { presetId: 'preset-4', lastUsedAt: 100 },
    ];
    mockSetActivePreset.mockImplementation(async (presetId: string) => {
      mockPresetStore.activePreset = mockPresetStore.presets.find(
        (preset) => preset.id === presetId
      );
      const nextLastUsedAt =
        Math.max(...mockPresetStore.activePresets.map((preset) => preset.lastUsedAt)) + 1;
      mockPresetStore.activePresets = mockPresetStore.activePresets.map((preset) =>
        preset.presetId === presetId ? { ...preset, lastUsedAt: nextLastUsedAt } : preset
      );
    });

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
    const presetPill = screen.getByTitle(/Ctrl\+\./i);
    expect(presetPill).toHaveTextContent('Codex');

    fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });
    await waitFor(() => expect(presetPill).toHaveTextContent('Claude Code'));

    fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });
    await waitFor(() => expect(presetPill).toHaveTextContent('OpenCode'));

    fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });
    await waitFor(() => expect(presetPill).toHaveTextContent('Gemini'));
  });

  it('restores a preset-specific launch mode when cycling presets', async () => {
    mockConfigHolder.value = {
      ...mockConfigHolder.value,
      defaultLaunchModeId: 'mode-1',
    };
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Codex Mode', command: 'codex --mode' }],
      },
      {
        id: 'preset-2',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [{ id: 'mode-2', name: 'Claude Plan', command: 'claude --plan' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 200, lastLaunchModeId: 'mode-1' },
      { presetId: 'preset-2', lastUsedAt: 100, lastLaunchModeId: 'mode-2' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
    fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByTitle(/click to select agent and launch mode/i)).toHaveTextContent(
        'Claude Code Claude Plan'
      );
    });
    expect(mockSetActivePreset).toHaveBeenCalledWith('preset-2');
  });

  it('persists launch mode changes for the selected preset', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [{ id: 'mode-1', name: 'Codex Mode', command: 'codex --mode' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByRole('button', { name: /^Codex, Codex Mode$/i }));

    expect(mockSetActivePreset).toHaveBeenCalledWith('preset-1', 'mode-1');
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('launches with the remembered reasoning level for the selected preset', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        reasoningLevels: [
          { id: 'r-low', name: 'Low', arguments: '--effort low' },
          { id: 'r-high', name: 'High', arguments: '--effort high' },
        ],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 100, lastReasoningLevelId: 'r-high' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    expect(screen.getByRole('button', { name: 'Claude Code Effort: High' })).toBeInTheDocument();
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-1', reasoningLevelId: 'r-high' })
    );
  });

  it('falls back to the agent default when the remembered level was removed', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        reasoningLevels: [{ id: 'r-low', name: 'Low', arguments: '--effort low' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 100, lastReasoningLevelId: 'r-removed' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    expect(screen.getByRole('button', { name: 'Claude Code Effort: Default' })).toBeInTheDocument();
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-1', reasoningLevelId: null })
    );
  });

  it('launches with the agent default after choosing Default effort', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        reasoningLevels: [{ id: 'r-high', name: 'High', arguments: '--effort high' }],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 100, lastReasoningLevelId: 'r-high' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByRole('button', { name: 'Claude Code Effort: High' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Default' }));
    expect(screen.getByRole('button', { name: 'Claude Code Effort: Default' })).toBeInTheDocument();
    expect(document.querySelector('[data-reasoning-meter]')).toBeNull();
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-1', reasoningLevelId: null })
    );
  });

  it('offers each effort level the agent defines, plus Default', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
        reasoningLevels: [
          { id: 'r-low', name: 'Low', arguments: '-c model_reasoning_effort=low' },
          { id: 'r-high', name: 'High', arguments: '-c model_reasoning_effort=high' },
        ],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    expect(document.querySelector('[data-reasoning-meter]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Codex Effort: Default' }));
    expect(screen.getAllByRole('menuitemradio').map((radio) => radio.textContent)).toEqual([
      'Default',
      'Low',
      'High',
    ]);

    await user.click(screen.getByRole('menuitemradio', { name: 'Low' }));
    expect(document.querySelectorAll('[data-reasoning-meter] [aria-hidden]')).toHaveLength(2);
    await user.click(getLaunchButton());

    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ presetId: 'preset-1', reasoningLevelId: 'r-low' })
      )
    );
  });

  it('shows the title and icon the agent gives its picker, without the effort meter', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        reasoningLevels: [{ id: 'r-opus', name: 'Opus', arguments: '--model opus' }],
        levelPicker: { title: 'Model', icon: 'cpu' },
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    const pill = screen.getByRole('button', { name: 'Claude Code Model: Default' });
    expect(pill).toHaveTextContent('Model');
    expect(pill).toHaveAttribute('title', 'Model');
    await user.click(pill);
    expect(screen.getByText('Claude Code Model')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Opus' }));

    expect(screen.getByRole('button', { name: 'Claude Code Model: Opus' })).toBeInTheDocument();
    expect(document.querySelector('[data-reasoning-meter]')).toBeNull();
  });

  it('hides the effort pill for agents without reasoning levels', async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    expect(screen.queryByRole('button', { name: /Effort/ })).not.toBeInTheDocument();
  });

  it('hides a hidden level picker and launches with the agent default', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Claude Code',
        openCommand: 'claude',
        promptCommand: 'claude {{prompt}}',
        launchModes: [],
        reasoningLevels: [{ id: 'r-high', name: 'High', arguments: '--effort high' }],
        levelPicker: { hidden: true },
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 100, lastReasoningLevelId: 'r-high' },
    ];

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    expect(screen.queryByRole('button', { name: /Effort/ })).not.toBeInTheDocument();
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace.mock.calls[0][0].reasoningLevelId).toBeUndefined();
  });

  it('asks to start a local workspace from origin', async () => {
    const user = userEvent.setup();

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByRole('button', { name: 'Start from main' }));
    expect(screen.getByTestId('branch-source')).toHaveTextContent(/from\s*main/);
    await user.click(getLaunchButton());

    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ baseBranch: 'main', startFromOrigin: true })
      )
    );
  });

  it('opens an existing branch locally and can go back to a new branch', async () => {
    const user = userEvent.setup();
    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Open feature/existing' }));
    expect(screen.queryByRole('textbox', { name: 'Branch name' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create a new branch instead' }));
    expect(screen.getByRole('textbox', { name: 'Branch name' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open feature/existing' }));
    await user.click(getLaunchButton());

    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'feature/existing',
          checkoutExistingBranch: true,
          fetchRemote: true,
        })
      )
    );
  });

  it('uses a newly selected launch mode before async preset persistence completes', async () => {
    const user = userEvent.setup();
    mockPresetStore.presets = [
      {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [
          { id: 'mode-1', name: 'Old Mode', command: 'codex --old' },
          { id: 'mode-2', name: 'New Mode', command: 'codex --new' },
        ],
      },
    ];
    mockPresetStore.activePreset = mockPresetStore.presets[0];
    mockPresetStore.activePresets = [
      { presetId: 'preset-1', lastUsedAt: 100, lastLaunchModeId: 'mode-1' },
    ];
    mockSetActivePreset.mockReturnValue(new Promise(() => {}));

    render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

    await screen.findByPlaceholderText('komla/swift-fox');
    await user.click(screen.getByRole('button', { name: /^Codex, New Mode$/i }));
    await user.click(getLaunchButton());

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ launchModeId: 'mode-2' })
    );
  });

  it('opens Voice settings from the voice indicator', async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    window.addEventListener('open-settings', openSettings);
    try {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: 'Voice settings' }));

      expect(openSettings).toHaveBeenCalledWith(expect.objectContaining({ detail: 'voice' }));
    } finally {
      window.removeEventListener('open-settings', openSettings);
    }
  });

  describe('voice shortcut interception', () => {
    it('intercepts komla:voice-toggle and calls stopAndTranscribe when recording', async () => {
      mockVoiceInput.isRecording = true;
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      // Wait for the component to mount and register the listener
      await screen.findByPlaceholderText('komla/swift-fox');

      const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
      const wasCancelled = !window.dispatchEvent(event);

      expect(wasCancelled).toBe(true);
      expect(mockVoiceInput.stopAndTranscribe).toHaveBeenCalled();
    });

    it('intercepts komla:voice-toggle and starts recording when idle', async () => {
      mockVoiceInput.isRecording = false;

      // Make model ready so startRecording is called
      mockVoiceStoreGetState.mockReturnValue({
        modelStatus: 'ready',
        loadModelStatus: vi.fn().mockResolvedValue(undefined),
      });

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
      window.dispatchEvent(event);

      expect(mockVoiceInput.startRecording).toHaveBeenCalled();
    });

    it('does not intercept when dialog has no agent', async () => {
      mockPresetStore.activePreset = {
        id: 'preset-1',
        name: 'Codex',
        openCommand: '',
        launchModes: [],
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
      const wasCancelled = !window.dispatchEvent(event);

      expect(wasCancelled).toBe(false);

      // Restore for other tests
      mockPresetStore.activePreset = {
        id: 'preset-1',
        name: 'Codex',
        openCommand: 'codex',
        promptCommand: 'codex {{prompt}}',
        launchModes: [],
      };
    });

    it('does not intercept when dialog is closed', async () => {
      render(<NewWorkspaceDialog open={false} onOpenChange={vi.fn()} />);

      const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
      const wasCancelled = !window.dispatchEvent(event);

      expect(wasCancelled).toBe(false);
    });

    it('silently ignores shortcut when model is not ready', async () => {
      mockVoiceInput.isRecording = false;

      mockVoiceStoreGetState.mockReturnValue({
        modelStatus: 'not-downloaded',
        loadModelStatus: vi.fn().mockResolvedValue(undefined),
      });

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
      window.dispatchEvent(event);

      expect(mockAddToast).not.toHaveBeenCalled();
      expect(mockVoiceInput.startRecording).not.toHaveBeenCalled();
    });

    it('keeps the prompt focused after the mic starts dictation, so Esc and Enter control it', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      const mic = screen.getByRole('button', { name: 'Dictate' });
      mic.focus();

      fireEvent.click(mic);

      expect(mockVoiceInput.startRecording).toHaveBeenCalled();
      expect(textarea).toHaveFocus();
    });

    it('keeps recording on keys that move the cursor and cancels once the user types', async () => {
      mockVoiceInput.isRecording = true;
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      for (const key of ['ArrowLeft', 'ArrowUp', 'Home', 'End', 'PageDown', 'F5']) {
        fireEvent.keyDown(textarea, { key });
      }
      fireEvent.keyDown(textarea, { key: 'a', metaKey: true });
      expect(mockVoiceInput.cancelRecording).not.toHaveBeenCalled();

      fireEvent.keyDown(textarea, { key: 'x' });
      expect(mockVoiceInput.cancelRecording).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(textarea, { key: 'Backspace' });
      fireEvent.keyDown(textarea, { key: 'v', ctrlKey: true });
      expect(mockVoiceInput.cancelRecording).toHaveBeenCalledTimes(3);
    });

    it('does not cancel an active recording when Shift+Tab cycles launch modes', async () => {
      mockVoiceInput.isRecording = true;
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [{ id: 'mode-1', name: 'Default', command: 'codex --x' }],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });

      expect(mockVoiceInput.cancelRecording).not.toHaveBeenCalled();
    });

    it('does not cancel an active recording when the preset cycle shortcut fires', async () => {
      mockVoiceInput.isRecording = true;
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-2',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [
        { presetId: 'preset-1', lastUsedAt: 200 },
        { presetId: 'preset-2', lastUsedAt: 100 },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });

      expect(mockVoiceInput.cancelRecording).not.toHaveBeenCalled();
      expect(mockSetActivePreset).toHaveBeenCalledWith('preset-2');
    });
  });

  describe('voice transcription insertion', () => {
    it('inserts transcription at cursor position', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      // Type some text, then position cursor in the middle
      await userEvent.type(textarea, 'hello world');
      // Place cursor after "hello " (position 6)
      (textarea as HTMLTextAreaElement).selectionStart = 6;
      (textarea as HTMLTextAreaElement).selectionEnd = 6;

      // Simulate transcription callback
      (mockVoiceInput as any)._onTranscription('beautiful ');

      await waitFor(() => {
        expect(textarea).toHaveValue('hello beautiful world');
      });
    });

    it('separates dictation from the words around it with spaces', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = (await screen.findByPlaceholderText(
        /what should the agent work on/i
      )) as HTMLTextAreaElement;

      await userEvent.type(textarea, 'Also');
      (mockVoiceInput as any)._onTranscription('fix the bug.');
      await waitFor(() => expect(textarea).toHaveValue('Also fix the bug.'));

      await waitFor(() => expect(textarea.selectionStart).toBe(17));
      textarea.setSelectionRange(0, 0);
      (mockVoiceInput as any)._onTranscription('Please');
      await waitFor(() => expect(textarea).toHaveValue('Please Also fix the bug.'));
    });

    it('replaces selected text with transcription', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      await userEvent.type(textarea, 'hello world');
      // Select "world" (positions 6-11)
      (textarea as HTMLTextAreaElement).selectionStart = 6;
      (textarea as HTMLTextAreaElement).selectionEnd = 11;

      (mockVoiceInput as any)._onTranscription('universe');

      await waitFor(() => {
        expect(textarea).toHaveValue('hello universe');
      });
    });

    /**
     * Regression: pressing Enter twice in quick succession used to submit
     * before the async transcription resolved, leaving the new workspace
     * without the spoken prompt. The second Enter must defer until
     * onTranscription has folded the text in, then submit with that text.
     */
    it('queues form submission when Enter is pressed during transcription', async () => {
      mockVoiceInput.isTranscribing = true;
      try {
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
        textarea.focus();
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        (mockVoiceInput as any)._onTranscription('write a regression test');

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'write a regression test' })
          );
        });
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });

    it('waits for every running transcription before a queued submission', async () => {
      mockVoiceInput.isTranscribing = true;
      try {
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
        const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
        fireEvent.keyDown(textarea, { key: 'Enter' });

        (mockVoiceInput as any)._onTranscription('fix the login bug.', true);
        await waitFor(() => expect(textarea).toHaveValue('fix the login bug.'));
        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        (mockVoiceInput as any)._onTranscription('Then run the tests.');
        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'fix the login bug. Then run the tests.' })
          );
        });
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });

    it('cancels running transcriptions when the dialog closes', async () => {
      const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      expect(mockVoiceInput.cancelTranscription).not.toHaveBeenCalled();

      rerender(<NewWorkspaceDialog open={false} onOpenChange={vi.fn()} />);

      expect(mockVoiceInput.cancelTranscription).toHaveBeenCalled();
    });

    /**
     * Regression: the synchronous-fallback added for the deferred-submit race
     * must not override an explicit user opt-out via the sparkle button. With
     * autoNameBranches enabled and a non-empty prompt, clicking the sparkle to
     * disable AI naming should result in a non-AI submission.
     */
    it('respects explicit AI-naming opt-out via the sparkle button', async () => {
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        autoNameBranches: true,
      };

      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, 'do the thing');

      // After typing, the auto-enable effect flips AI naming on; click sparkle to opt out.
      const sparkleButton = await screen.findByRole('button', { name: /use random branch name/i });
      await user.click(sparkleButton);

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const args = mockCreateWorkspace.mock.calls[0][0];
      expect(args.autoNameBranches).toBeFalsy();
      expect(args.branchName).toBe('komla/swift-fox');
      expect(args.initialPrompt).toBe('do the thing');
    });

    /**
     * Regression: the auto-enable effect previously re-overrode the user's
     * opt-out the moment they typed another character. With the override ref
     * applied to the effect too, an opt-out followed by further prompt edits
     * still submits without AI naming.
     */
    it('keeps AI-naming disabled after editing the prompt following an opt-out', async () => {
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        autoNameBranches: true,
      };

      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, 'do the thing');

      const sparkleButton = await screen.findByRole('button', { name: /use random branch name/i });
      await user.click(sparkleButton);

      // Editing the prompt after opt-out must not re-enable AI naming.
      await user.type(textarea, ' more');

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const args = mockCreateWorkspace.mock.calls[0][0];
      expect(args.autoNameBranches).toBeFalsy();
      expect(args.branchName).toBe('komla/swift-fox');
      expect(args.initialPrompt).toBe('do the thing more');
    });

    /**
     * Regression: clicking Create while the mic is still recording must stop
     * the mic, transcribe what was captured so far, and submit with that
     * text — not lose the audio by submitting empty + closing the dialog.
     */
    it('stops recording, transcribes, and submits when Create is clicked while recording', async () => {
      mockVoiceInput.isRecording = true;
      try {
        const user = userEvent.setup();
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        await user.click(getLaunchButton());

        expect(mockVoiceInput.stopAndTranscribe).toHaveBeenCalled();
        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        (mockVoiceInput as any)._onTranscription('hello mid-recording');

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'hello mid-recording' })
          );
        });
      } finally {
        mockVoiceInput.isRecording = false;
      }
    });

    /**
     * Regression: clicking Create (or any non-Enter form submit) while
     * transcription is in flight used to fall through to handleSubmit and
     * read the still-empty prompt. The isTranscribing guard inside
     * handleSubmit must queue the submission for after transcription.
     */
    it('queues form submission when Create is clicked during transcription', async () => {
      mockVoiceInput.isTranscribing = true;
      try {
        const user = userEvent.setup();
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        await user.click(getLaunchButton());

        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        (mockVoiceInput as any)._onTranscription('hello from the button');

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'hello from the button' })
          );
        });
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });

    /**
     * Regression: when the queued submit fires synchronously from
     * onTranscription, the useAiBranchName effect hasn't re-run yet — so
     * createWorkspaceWithPrompt must derive the AI-naming decision from the
     * submitted prompt rather than the lagging state.
     */
    it('uses AI branch naming on raced submit when autoNameBranches is enabled', async () => {
      mockVoiceInput.isTranscribing = true;
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        autoNameBranches: true,
      };
      try {
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
        textarea.focus();
        fireEvent.keyDown(textarea, { key: 'Enter' });

        (mockVoiceInput as any)._onTranscription('build a feature');

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({
              autoNameBranches: true,
              deferBranchNaming: true,
              initialPrompt: 'build a feature',
            })
          );
        });
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });

    /**
     * Regression: clicking Create while recording, when useVoiceInput then
     * skips onTranscription entirely (mic permission still pending, empty
     * audio buffer, empty transcript, or transcribe error), used to leave
     * the queued submit dangling and the Create button as a silent no-op.
     * The fallback effect must submit with the current textarea contents
     * anyway — the prompt the user already typed must not be lost.
     */
    it('falls back to current prompt when recording yields no transcription callback', async () => {
      try {
        const user = userEvent.setup();
        const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
        await user.type(textarea, 'pre-existing prompt');

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        // User starts recording (after typing the prompt).
        mockVoiceInput.isRecording = true;
        rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        await user.click(getLaunchButton());

        expect(mockVoiceInput.stopAndTranscribe).toHaveBeenCalled();
        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        // useVoiceInput flips isRecording to false but skips onTranscription
        // (e.g. audio handle was null or the buffer was empty).
        mockVoiceInput.isRecording = false;
        rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'pre-existing prompt' })
          );
        });
      } finally {
        mockVoiceInput.isRecording = false;
      }
    });

    /**
     * Regression: clicking Create while transcription is in flight, when
     * the transcription then resolves with empty text (or throws) so
     * onTranscription is never invoked. Same orphaned-queued-submit class
     * as the recording case — the fallback effect must still submit with
     * the prompt the user already typed.
     */
    it('falls back to current prompt when in-flight transcription yields no callback', async () => {
      try {
        const user = userEvent.setup();
        const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
        await user.type(textarea, 'typed before transcription');

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        // Transcription is now in flight (mic stopped, awaiting result).
        mockVoiceInput.isTranscribing = true;
        rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        await user.click(getLaunchButton());

        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        // Transcription resolves with empty text or errors — onTranscription
        // is skipped entirely, isTranscribing flips false.
        mockVoiceInput.isTranscribing = false;
        rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

        await waitFor(() => {
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ initialPrompt: 'typed before transcription' })
          );
        });
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });

    /**
     * Regression: closing the dialog while a submit is queued through
     * transcription must clear the queued flag so the fallback effect
     * doesn't fire after teardown and create a workspace the user
     * already abandoned.
     */
    it('does not submit when dialog closes before voice state settles', async () => {
      mockVoiceInput.isTranscribing = true;
      try {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);

        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        await user.click(getLaunchButton());

        expect(mockCreateWorkspace).not.toHaveBeenCalled();

        // Dialog is closed (programmatically) while transcription is still
        // in flight. The close path must clear the queued-submit ref.
        rerender(<NewWorkspaceDialog open={false} onOpenChange={onOpenChange} />);

        // Then transcription resolves with no callback (e.g. transcribe error).
        mockVoiceInput.isTranscribing = false;
        rerender(<NewWorkspaceDialog open={false} onOpenChange={onOpenChange} />);

        // Effects ran synchronously inside the act-wrapped rerenders. If the
        // fallback was going to fire it would have by now.
        expect(mockCreateWorkspace).not.toHaveBeenCalled();
      } finally {
        mockVoiceInput.isTranscribing = false;
      }
    });
  });

  describe('AI branch naming toggle', () => {
    it('offers AI branch naming before a prompt is typed', async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await screen.findByPlaceholderText('komla/swift-fox');

      expect(screen.getByRole('button', { name: 'Generate branch name with AI' })).toBeVisible();
    });

    it('keeps AI branch naming on for later workspaces once turned on', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      await user.click(screen.getByRole('button', { name: 'Generate branch name with AI' }));

      expect(mockUpdateConfig).toHaveBeenCalledWith({ autoNameBranches: true });
      expect(screen.getByRole('button', { name: 'Use random branch name' })).toBeVisible();
      // Nothing to name the branch from yet, so the random name stays editable.
      expect(screen.getByLabelText('Branch name')).toHaveValue('komla/swift-fox');

      await user.type(
        screen.getByPlaceholderText(/what should the agent work on/i),
        'Fix the login flow'
      );

      expect(screen.getByText('AI generated')).toBeVisible();
    });

    it('turns AI branch naming off for later workspaces', async () => {
      mockConfigHolder.value = { ...mockConfigHolder.value, autoNameBranches: true };
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      await user.click(screen.getByRole('button', { name: 'Use random branch name' }));

      expect(mockUpdateConfig).toHaveBeenCalledWith({ autoNameBranches: false });
    });

    it('uses a typed branch name for this workspace only', async () => {
      mockConfigHolder.value = { ...mockConfigHolder.value, autoNameBranches: true };
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');

      await user.clear(branchInput);
      await user.type(branchInput, 'komla/my-branch');
      await user.type(
        screen.getByPlaceholderText(/what should the agent work on/i),
        'Fix the login flow'
      );

      expect(screen.getByLabelText('Branch name')).toHaveValue('komla/my-branch');
      expect(mockUpdateConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ autoNameBranches: expect.anything() })
      );

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const args = mockCreateWorkspace.mock.calls[0][0];
      expect(args.branchName).toBe('komla/my-branch');
      expect(args.autoNameBranches).toBeFalsy();
    });

    it('shows AI branch naming as on again when the dialog reopens', async () => {
      mockConfigHolder.value = { ...mockConfigHolder.value, autoNameBranches: true };
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      await user.type(screen.getByPlaceholderText(/what should the agent work on/i), 'first');
      await user.click(getLaunchButton());
      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());

      rerender(<NewWorkspaceDialog open={false} onOpenChange={onOpenChange} />);
      rerender(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);
      await screen.findByPlaceholderText('komla/swift-fox');

      expect(screen.getByRole('button', { name: 'Use random branch name' })).toBeVisible();
      await user.type(screen.getByPlaceholderText(/what should the agent work on/i), 'second');
      expect(screen.getByText('AI generated')).toBeVisible();
    });

    it('swaps "AI generated" for a branch name for this workspace only', async () => {
      mockConfigHolder.value = { ...mockConfigHolder.value, autoNameBranches: true };
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText('komla/swift-fox');
      await user.type(
        screen.getByPlaceholderText(/what should the agent work on/i),
        'Fix the login flow'
      );

      await user.click(screen.getByRole('button', { name: 'AI generated' }));

      const branchInput = screen.getByLabelText('Branch name');
      expect(branchInput).toHaveValue('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveFocus());
      expect(mockUpdateConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ autoNameBranches: expect.anything() })
      );

      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const args = mockCreateWorkspace.mock.calls[0][0];
      expect(args.branchName).toBe('komla/swift-fox');
      expect(args.autoNameBranches).toBeFalsy();
    });

    it('keeps conflict checks for a typed branch name when there is no prompt to name it from', async () => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');

      await user.clear(branchInput);
      await user.type(branchInput, 'komla/my-branch');
      await user.click(screen.getByRole('button', { name: 'Generate branch name with AI' }));
      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const args = mockCreateWorkspace.mock.calls[0][0];
      expect(args.branchName).toBe('komla/my-branch');
      expect(args.autoResolveBranchConflicts).toBe(false);
    });
  });

  describe('environment choice', () => {
    it('adds an SSH host over the dialog and picks it for the workspace', async () => {
      useSshHostDialogStore.setState({ open: false, request: null, requestId: 0 });
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);

      await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.click(screen.getByRole('button', { name: 'Connect a machine over SSH…' }));

      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      const { request } = useSshHostDialogStore.getState();
      expect(request).toMatchObject({ kind: 'add', source: 'new_workspace' });
      if (request?.kind !== 'add') throw new Error('expected an add request');
      request.onAdded?.('ssh-new');

      await waitFor(() =>
        expect(mockUpdateConfig).toHaveBeenCalledWith({
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-new' },
        })
      );
    });

    it('picks a host staged for it while it is open', async () => {
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com', basePath: '~/.komla' },
      ];
      const { rerender } = render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      expect(screen.queryByRole('button', { name: /Build Server/i })).not.toBeInTheDocument();

      mockDialogPrefill.value = { sshHostId: 'remote' };
      rerender(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /Build Server/i })).not.toHaveLength(0)
      );
      expect(mockDialogPrefill.value).toBeNull();
    });

    it('shows Local and SSH hosts in one icon-labelled environment list', async () => {
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
        { id: 'gpu', name: 'GPU Box', hostname: 'gpu.example.com' },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const buildOption = await screen.findByRole('button', { name: /^Build Server$/i });
      const gpuOption = screen.getByRole('button', { name: /^GPU Box$/i });
      const localOptions = screen.getAllByRole('button', { name: /^Local$/i });

      expect(buildOption.querySelector('svg')).not.toBeNull();
      expect(gpuOption.querySelector('svg')).not.toBeNull();
      expect(localOptions.every((option) => option.querySelector('svg'))).toBe(true);
      expect(screen.queryByText('SSH Hosts')).not.toBeInTheDocument();
    });

    it('cycles directly between Local and a single SSH host', async () => {
      const user = userEvent.setup();
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: /^Local$/i }));
      const sshPill = screen.getByRole('button', { name: /^Build Server$/i });

      await user.click(sshPill);

      expect(screen.getByRole('button', { name: /^Local/i })).toBeInTheDocument();
    });

    it('starts on the last-used SSH host and remembers switching to local', async () => {
      const user = userEvent.setup();
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      // Wait for auto-generated branch so submit has a valid branch to use.
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

      // With one SSH host, clicking the two-state pill switches back to local.
      await user.click(screen.getByRole('button', { name: /^Build Server/i }));
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        lastWorkspaceEnvironment: { kind: 'local' },
      });

      await user.click(getLaunchButton());

      await waitFor(() => {
        expect(mockCreateWorkspace).toHaveBeenCalled();
      });
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ environment: { kind: 'local' } })
      );
    });

    it('creates the first SSH workspace without asking where Terminal Commands run', async () => {
      const user = userEvent.setup();
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
      expect(screen.getAllByRole('button', { name: /Build Server/i })).not.toHaveLength(0);

      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ environment: { kind: 'ssh', hostId: 'remote' } })
        )
      );
      expect(
        screen.queryByText('Where should Terminal Commands run by default?')
      ).not.toBeInTheDocument();
      expect(mockUpdateProject).not.toHaveBeenCalled();
      expect(window.api.verifySshHost).not.toHaveBeenCalled();
    });

    it('uses an SSH host prefilled by a settings integration launch', async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];
      mockDialogPrefill.value = { sshHostId: 'remote' };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
      expect(screen.getAllByRole('button', { name: /Build Server/i })).not.toHaveLength(0);

      await user.click(getLaunchButton());

      expect(
        screen.queryByText('Where should Terminal Commands run by default?')
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ environment: { kind: 'ssh', hostId: 'remote' } })
        )
      );
      // A prefilled host applies to this launch only.
      expect(mockUpdateConfig).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastWorkspaceEnvironment: expect.anything() })
      );
    });

    it('offers the full branch options and opens an existing branch over SSH', async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: 'Open feature/existing' }));
      expect(screen.getByText('feature/existing')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Branch name' })).not.toBeInTheDocument();
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            branchName: 'feature/existing',
            checkoutExistingBranch: true,
            fetchRemote: true,
            environment: { kind: 'ssh', hostId: 'remote' },
          })
        )
      );
    });

    it('uses the branch picker for an SSH workspace base branch', async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: 'Start from main' }));
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'main',
            checkoutExistingBranch: undefined,
            environment: { kind: 'ssh', hostId: 'remote' },
          })
        )
      );
    });

    it('qualifies a remote-only SSH workspace base branch', async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: 'Start from feature/existing' }));
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'origin/feature/existing',
            checkoutExistingBranch: undefined,
            environment: { kind: 'ssh', hostId: 'remote' },
          })
        )
      );
    });

    it("starts an SSH workspace from a branch on the host's clone", async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        {
          id: 'remote',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: 'Start from host/only' }));
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'host/only',
            baseBranchOnHost: true,
            environment: { kind: 'ssh', hostId: 'remote' },
          })
        )
      );
    });

    it.each([
      ['Start from host/only', 'starting from'],
      ['Open host/only', 'opening'],
    ])("forgets a host's branch when %s and switching to this computer", async (button) => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
      ];

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      await user.click(await screen.findByRole('button', { name: button }));
      await user.click(screen.getByRole('button', { name: /^Build Server/i }));
      await user.click(getLaunchButton());

      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
      const params = mockCreateWorkspace.mock.calls[0][0];
      expect(params).toMatchObject({ environment: { kind: 'local' } });
      expect(params.baseBranch).not.toBe('host/only');
      expect(params.branchName).not.toBe('host/only');
      expect(params.checkoutExistingBranch).toBeUndefined();
    });

    it('keeps a prefilled SSH host when the launch mode changes', async () => {
      const user = userEvent.setup();
      mockProjects[0].sshWorkspaceMode = 'remote';
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [{ id: 'mode-1', name: 'Codex Mode', command: 'codex --mode' }],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
      mockSshHostsHolder.value = [
        { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
      ];
      mockDialogPrefill.value = { sshHostId: 'remote' };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
      fireEvent.keyDown(screen.getByPlaceholderText(/what should the agent work on/i), {
        key: 'Tab',
        shiftKey: true,
      });
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ environment: { kind: 'ssh', hostId: 'remote' } })
        )
      );
    });
  });

  describe('new workspace from another workspace', () => {
    const buildServer = {
      id: 'remote',
      name: 'Build Server',
      hostname: 'build.example.com',
      basePath: '~/.komla',
    };
    const localSource = {
      id: 'ws-source',
      projectId: 'project-komla',
      branchName: 'komla/feature',
      workingDirectory: '/worktrees/feature',
      isWorktree: true,
    };
    const sshSource = {
      ...localSource,
      workingDirectory: 'ssh://remote/home/dev/.komla/feature',
      backend: { kind: 'ssh', hostId: 'remote' },
    };
    const branchStatus = (overrides: Record<string, unknown> = {}) => ({
      behindTargetBranch: 0,
      aheadTargetBranch: 2,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: false,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'komla/feature',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
      ...overrides,
    });

    const onOrigin = [
      { name: 'main', isRemoteOnly: true, remoteRef: 'origin/main' },
      { name: 'komla/feature', isRemoteOnly: true, remoteRef: 'origin/komla/feature' },
    ];

    beforeEach(() => {
      useGitStatusStore.getState().cleanup('ws-source');
      mockSshHostsHolder.value = [buildServer];
      window.api.getWorkspaceGitBranchStatus = vi.fn().mockResolvedValue(branchStatus());
      window.api.listBranches = vi
        .fn()
        .mockResolvedValue([{ name: 'main', isRemoteOnly: true, remoteRef: 'origin/main' }]);
      window.api.pushWorkspace = vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Published komla/feature to origin' });
    });

    it('starts where a local source workspace runs, even when the last launch used SSH', async () => {
      const user = userEvent.setup();
      mockConfigHolder.value = {
        ...mockConfigHolder.value,
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
      };
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'komla/feature',
            environment: { kind: 'local' },
            sourceWorkspaceId: 'ws-source',
          })
        )
      );
    });

    it('asks to push a local-only branch before an SSH host starts from it', async () => {
      const user = userEvent.setup();
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Local$/i }));

      expect(
        await screen.findByText(/komla\/feature is only on this computer/i)
      ).toBeInTheDocument();
      expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith(
        'ws-source',
        'project-komla'
      );

      await user.click(getLaunchButton());
      expect(mockCreateWorkspace).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/push komla\/feature/i);

      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true }));
      window.api.listBranches = vi.fn().mockResolvedValue(onOrigin);
      await user.click(screen.getByRole('button', { name: /^Push$/ }));

      expect(window.api.pushWorkspace).toHaveBeenCalledWith('ws-source');
      await waitFor(() =>
        expect(screen.queryByText(/is only on this computer/i)).not.toBeInTheDocument()
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'komla/feature',
            environment: { kind: 'ssh', hostId: 'remote' },
          })
        )
      );
    });

    it('asks to push a branch only on the SSH host before starting it locally', async () => {
      const user = userEvent.setup();
      mockWorkspaces.value = [sshSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sshHostId: 'remote',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      // The source's own host clones from its repository, so origin doesn't matter there.
      expect(screen.queryByText(/is only on/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^Build Server$/i }));

      expect(await screen.findByText(/komla\/feature is only on Build Server/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^Push$/ }));
      expect(window.api.pushWorkspace).toHaveBeenCalledWith('ws-source');
    });

    it('warns without blocking when origin lacks some of the branch’s commits', async () => {
      const user = userEvent.setup();
      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true, unpushedCommits: 2 }));
      window.api.listBranches = vi.fn().mockResolvedValue(onOrigin);
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Local$/i }));

      expect(await screen.findByText(/2 unpushed commits/i)).toBeInTheDocument();
      await user.click(getLaunchButton());
      await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    });

    it('says nothing when the branch is on origin', async () => {
      const user = userEvent.setup();
      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true }));
      window.api.listBranches = vi.fn().mockResolvedValue(onOrigin);
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Local$/i }));

      await waitFor(() => expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalled());
      await waitFor(() => expect(window.api.listBranches).toHaveBeenCalled());
      expect(screen.queryByText(/is only on/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Push$/ })).not.toBeInTheDocument();
    });

    it('treats a branch tracking another origin branch as not on origin', async () => {
      const user = userEvent.setup();
      // Made with `git checkout -b komla/feature origin/main`, so it has an upstream.
      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true, unpushedCommits: 1 }));
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Local$/i }));

      expect(
        await screen.findByText(/komla\/feature is only on this computer/i)
      ).toBeInTheDocument();
      expect(window.api.listBranches).toHaveBeenCalledWith('/worktrees/feature', true);
    });

    it('holds Launch while the push is running', async () => {
      const user = userEvent.setup();
      let finishPush: (result: { success: boolean; message: string }) => void = () => {};
      window.api.pushWorkspace = vi.fn(
        () =>
          new Promise((resolve) => {
            finishPush = resolve;
          })
      );
      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true, unpushedCommits: 2 }));
      window.api.listBranches = vi.fn().mockResolvedValue(onOrigin);
      mockWorkspaces.value = [localSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Local$/i }));
      await user.click(await screen.findByRole('button', { name: /^Push$/ }));

      expect(getLaunchButton()).toBeDisabled();
      fireEvent.submit(getLaunchButton().closest('form')!);
      expect(mockCreateWorkspace).not.toHaveBeenCalled();

      window.api.getWorkspaceGitBranchStatus = vi
        .fn()
        .mockResolvedValue(branchStatus({ hasRemote: true }));
      await act(async () => finishPush({ success: true, message: 'Pushed 2 commits to origin' }));
      await waitFor(() => expect(getLaunchButton()).toBeEnabled());
    });

    it('uses an SSH source’s pushed status instead of asking its host again', async () => {
      const user = userEvent.setup();
      useGitStatusStore.getState().hydrateStatus('ws-source', branchStatus());
      mockWorkspaces.value = [sshSource];
      mockDialogPrefill.value = {
        projectId: 'project-komla',
        baseBranch: 'komla/feature',
        sshHostId: 'remote',
        sourceWorkspaceId: 'ws-source',
      };

      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await user.click(await screen.findByRole('button', { name: /^Build Server$/i }));

      expect(await screen.findByText(/komla\/feature is only on Build Server/i)).toBeInTheDocument();
      expect(window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
    });
  });

  describe('project shortcuts', () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    const originalScrollIntoView = Element.prototype.scrollIntoView;

    beforeEach(() => {
      // The project search is a real Radix popover, which measures its anchor.
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      Element.prototype.scrollIntoView = vi.fn();
      useShortcutsStore.setState({
        config: { shortcuts: { 'workspace.new': 'Cmd+N', 'workspace.select.2': 'Cmd+2' } } as any,
      });
    });

    afterEach(() => {
      globalThis.ResizeObserver = OriginalResizeObserver;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      useShortcutsStore.setState({ config: null });
    });

    const renderWithPrompt = async (prompt: string) => {
      const user = userEvent.setup();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));
      const textarea = screen.getByPlaceholderText(/what should the agent work on/i);
      await user.type(textarea, prompt);
      return { user, textarea, branchInput };
    };

    it('selects a project by its number and keeps the prompt focused', async () => {
      const { user, textarea, branchInput } = await renderWithPrompt('Fix the flaky test');

      fireEvent.keyDown(textarea, { key: '2', ctrlKey: true });

      await waitFor(() => expect(branchInput).toHaveValue('swift-fox'));
      expect(textarea).toHaveValue('Fix the flaky test');
      expect(textarea).toHaveFocus();

      await user.click(getLaunchButton());
      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-empty',
            branchName: 'swift-fox',
            initialPrompt: 'Fix the flaky test',
          })
        )
      );
    });

    it.each(['Start from feature/existing', 'Open feature/existing'])(
      'drops the branch picked with "%s" when switching projects',
      async (choice) => {
        const { user, textarea } = await renderWithPrompt('Fix the flaky test');
        await user.click(screen.getByRole('button', { name: choice }));

        fireEvent.keyDown(textarea, { key: '2', ctrlKey: true });
        await user.click(getLaunchButton());

        // A new branch from the new project's default base.
        await waitFor(() =>
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({
              projectId: 'project-empty',
              branchName: 'swift-fox',
              baseBranch: undefined,
            })
          )
        );
      }
    );

    it('returns focus to the branch name from the project search without an agent', async () => {
      const user = userEvent.setup();
      mockPresetStore.activePreset = {
        id: 'shell-only',
        name: 'Shell Only',
        openCommand: '',
        launchModes: [],
      };
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveFocus());

      fireEvent.keyDown(branchInput, { key: 'n', ctrlKey: true });
      const search = await screen.findByRole('combobox', { name: /search projects/i });
      await waitFor(() => expect(search).toHaveFocus());
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
      await waitFor(() => expect(branchInput).toHaveFocus());
    });

    it('moves focus out of an open menu when switching projects without an agent', async () => {
      mockPresetStore.activePreset = {
        id: 'shell-only',
        name: 'Shell Only',
        openCommand: '',
        launchModes: [],
      };
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

      // Focus leaving a menu closes it, so the branch picker can't list the old project's branches.
      const branchPickerItem = screen.getByRole('button', { name: 'Start from main' });
      branchPickerItem.focus();
      fireEvent.keyDown(branchPickerItem, { key: '2', ctrlKey: true });

      await waitFor(() => expect(branchInput).toHaveValue('swift-fox'));
      expect(branchInput).toHaveFocus();
    });

    it("checks a typed branch name against the new project's worktrees", async () => {
      window.api.getWorktreeBranches = vi.fn((repoPath: string) =>
        repoPath === '/repos/komla' ? Promise.resolve(['feature/taken']) : new Promise(() => {})
      ) as any;
      const { user, textarea, branchInput } = await renderWithPrompt('Fix the flaky test');
      await user.clear(branchInput);
      await user.type(branchInput, 'feature/taken');
      await user.click(getLaunchButton());
      expect(await screen.findByText(/feature\/taken" is already checked out/)).toBeInTheDocument();

      // The new project's worktrees are still loading.
      fireEvent.keyDown(textarea, { key: '2', ctrlKey: true });
      await user.click(getLaunchButton());

      await waitFor(() =>
        expect(mockCreateWorkspace).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'project-empty', branchName: 'feature/taken' })
        )
      );
    });

    it('uses a non-modal Saved Prompts menu, so a project shortcut can close it', async () => {
      mockActionsHolder.value = [
        { id: 'prompt', title: 'Review changes', type: 'prompt', content: 'Review these changes' },
      ];
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);

      const menuLabel = await screen.findByText('Saved Prompts');
      expect(menuLabel.closest('[data-modal]')).toHaveAttribute('data-modal', 'false');
    });

    it('opens a folder project on this computer when an SSH host was used last', async () => {
      const user = userEvent.setup();
      mockProjects.unshift({
        id: 'project-folder',
        name: 'Downloads',
        kind: 'directory',
        repositoryPath: '/Users/me/Downloads',
      });
      try {
        mockConfigHolder.value = {
          ...mockConfigHolder.value,
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
        };
        mockSshHostsHolder.value = [
          { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
        ];
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
        await screen.findByPlaceholderText('komla/swift-fox');

        await user.click(screen.getByRole('button', { name: /Downloads/ }));
        await waitFor(() => expect(screen.queryByText('Build Server')).not.toBeInTheDocument());
        await user.click(getLaunchButton());

        await waitFor(() =>
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'directory', projectId: 'project-folder' })
          )
        );
        expect(mockCreateWorkspace.mock.calls[0][0].environment?.kind).not.toBe('ssh');
        // Only a location the user picks becomes the one later workspaces start in.
        expect(mockUpdateConfig).not.toHaveBeenCalledWith(
          expect.objectContaining({ lastWorkspaceEnvironment: expect.anything() })
        );
      } finally {
        mockProjects.shift();
      }
    });

    it('leaves a folder project for a Git project when an SSH host is picked', async () => {
      const user = userEvent.setup();
      mockProjects.unshift({
        id: 'project-folder',
        name: 'Downloads',
        kind: 'directory',
        repositoryPath: '/Users/me/Downloads',
      });
      try {
        mockSshHostsHolder.value = [
          { id: 'remote', name: 'Build Server', hostname: 'build.example.com' },
        ];
        mockDialogPrefill.value = { projectId: 'project-folder' };
        render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
        await screen.findByPlaceholderText(/what should the agent work on/i);

        // With one SSH host, the location pill switches between it and Local.
        await user.click(await screen.findByRole('button', { name: /^Local$/i }));
        await user.click(getLaunchButton());

        await waitFor(() =>
          expect(mockCreateWorkspace).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: 'project-komla' })
          )
        );
        expect(mockUpdateConfig).toHaveBeenCalledWith({
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'remote' },
        });
      } finally {
        mockProjects.shift();
      }
    });

    it('opens a project search when the New workspace shortcut is pressed again', async () => {
      const { user, textarea, branchInput } = await renderWithPrompt('Fix the flaky test');

      fireEvent.keyDown(textarea, { key: 'n', ctrlKey: true });

      const search = await screen.findByRole('combobox', { name: /search projects/i });
      await waitFor(() => expect(search).toHaveFocus());
      expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);

      await user.type(search, 'empty');
      expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
      await user.keyboard('{Enter}');

      await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
      await waitFor(() => expect(textarea).toHaveFocus());
      expect(textarea).toHaveValue('Fix the flaky test');
      await waitFor(() => expect(branchInput).toHaveValue('swift-fox'));
    });

    it('opens the project search with a custom New workspace binding', async () => {
      useShortcutsStore.setState({
        config: { shortcuts: { 'workspace.new': 'Cmd+Shift+K' } } as any,
      });
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.keyDown(textarea, { key: 'n', ctrlKey: true });
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: 'k', ctrlKey: true, shiftKey: true });
      expect(await screen.findByRole('combobox', { name: /search projects/i })).toBeInTheDocument();
    });

    it('keeps app-wide workspace shortcuts from acting behind the dialog', async () => {
      const selectWorkspace = vi.fn();
      const openNewWorkspace = vi.fn();
      function AppShortcuts() {
        useShortcuts({ 'workspace.select.2': selectWorkspace, 'workspace.new': openNewWorkspace });
        return null;
      }
      const windowKeyDown = vi.fn();
      window.addEventListener('keydown', windowKeyDown);
      try {
        render(
          <>
            <AppShortcuts />
            <NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />
          </>
        );
        const branchInput = await screen.findByPlaceholderText('komla/swift-fox');
        await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

        // Buttons are not skipped by the app-wide handler the way text fields are.
        const launchButton = getLaunchButton();
        launchButton.focus();
        fireEvent.keyDown(launchButton, { key: '2', ctrlKey: true });
        fireEvent.keyDown(launchButton, { key: 'n', ctrlKey: true });

        expect(selectWorkspace).not.toHaveBeenCalled();
        expect(openNewWorkspace).not.toHaveBeenCalled();
        await waitFor(() => expect(branchInput).toHaveValue('swift-fox'));
        expect(
          await screen.findByRole('combobox', { name: /search projects/i })
        ).toBeInTheDocument();
        // Still delivered, so double-tap detection sees a key other than the modifier.
        expect(windowKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: '2' }));
      } finally {
        window.removeEventListener('keydown', windowKeyDown);
      }
    });

    it('does not cancel an active recording when a project shortcut fires', async () => {
      mockVoiceInput.isRecording = true;
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.keyDown(textarea, { key: '2', ctrlKey: true });
      fireEvent.keyDown(textarea, { key: 'n', ctrlKey: true });

      expect(await screen.findByRole('combobox', { name: /search projects/i })).toBeInTheDocument();
      expect(mockVoiceInput.cancelRecording).not.toHaveBeenCalled();
    });
  });

  describe('customized shortcuts', () => {
    const usePresetWithModeAndEffort = () => {
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [{ id: 'mode-1', name: 'Plan', command: 'claude --plan' }],
          reasoningLevels: [
            { id: 'r-low', name: 'Low', arguments: '--effort low' },
            { id: 'r-high', name: 'High', arguments: '--effort high' },
          ],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    };

    it('cycles effort with Shift+Tab once launch modes move to other keys', async () => {
      seedShortcuts({
        'newWorkspace.cycleLaunchMode': 'Cmd+L',
        'newWorkspace.cycleEffort': 'Shift+Tab',
      });
      usePresetWithModeAndEffort();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      const branchInput = screen.getByPlaceholderText('komla/swift-fox');

      expect(fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true })).toBe(false);
      expect(screen.getByRole('button', { name: 'Claude Code Effort: Low' })).toBeInTheDocument();
      expect(mockSetActivePreset).not.toHaveBeenCalled();

      // Shift+Tab still moves focus back from the other controls...
      expect(fireEvent.keyDown(branchInput, { key: 'Tab', shiftKey: true })).toBe(true);
      // ...while the launch mode's new keys work from anywhere in the dialog.
      expect(fireEvent.keyDown(branchInput, { key: 'l', ctrlKey: true })).toBe(false);
      expect(mockSetActivePreset).toHaveBeenCalledWith('preset-1', 'mode-1');
    });

    it('opens the effort menu with its shortcut', async () => {
      seedShortcuts({ 'newWorkspace.effortMenu': 'Cmd+E' });
      usePresetWithModeAndEffort();
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      const effortMenu = screen
        .getByRole('button', { name: 'Claude Code Effort: Default' })
        .closest('[data-open]');
      expect(effortMenu).toHaveAttribute('data-open', 'false');

      expect(fireEvent.keyDown(textarea, { key: 'e', ctrlKey: true })).toBe(false);

      expect(effortMenu).toHaveAttribute('data-open', 'true');
    });

    it('picks the next project with its shortcut', async () => {
      seedShortcuts({ 'newWorkspace.cycleProject': 'Alt+P' });
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      const branchInput = screen.getByPlaceholderText('komla/swift-fox');
      await waitFor(() => expect(branchInput).toHaveValue('komla/swift-fox'));

      fireEvent.keyDown(textarea, { key: 'p', altKey: true });

      await waitFor(() => expect(branchInput).toHaveValue('swift-fox'));
    });

    it('leaves an unbound agent cycle out of the dialog and its hints', async () => {
      const user = userEvent.setup();
      seedShortcuts({ 'newWorkspace.cycleAgent': '' });
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-2',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [
        { presetId: 'preset-1', lastUsedAt: 200 },
        { presetId: 'preset-2', lastUsedAt: 100 },
      ];
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      expect(fireEvent.keyDown(textarea, { key: '.', ctrlKey: true })).toBe(true);
      expect(mockSetActivePreset).not.toHaveBeenCalled();

      await user.click(screen.getByTitle(/click to select agent and launch mode/i));
      expect(screen.queryByText(/cycle agent/i)).not.toBeInTheDocument();
    });

    it('keeps a shortcut whose control is hidden from acting behind the dialog', async () => {
      seedShortcuts({ 'newWorkspace.effortMenu': 'Cmd+Shift+D' });
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
      const claimed: boolean[] = [];
      const recordClaim = (event: KeyboardEvent) => claimed.push(isShortcutEventClaimed(event));
      window.addEventListener('keydown', recordClaim);
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);

      fireEvent.keyDown(textarea, { key: 'D', ctrlKey: true, shiftKey: true });
      window.removeEventListener('keydown', recordClaim);

      expect(claimed).toEqual([true]);
    });

    it('picks a single ticked agent when a shortcut opens another menu', async () => {
      const user = userEvent.setup();
      seedShortcuts({ 'newWorkspace.branchMenu': 'Alt+B' });
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
        {
          id: 'preset-2',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [
        { presetId: 'preset-1', lastUsedAt: 200 },
        { presetId: 'preset-2', lastUsedAt: 100 },
      ];
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);
      const picker = screen.getByTitle(/click to select agent/i);
      await user.click(picker);
      await user.click(screen.getByRole('button', { name: /^select multiple$/i }));
      await user.click(screen.getByRole('button', { name: /show claude code launch modes/i }));
      const checkbox = screen.getByRole('checkbox', { name: /^Claude Code, Default$/i });
      await user.click(checkbox);

      fireEvent.keyDown(checkbox, { key: 'b', altKey: true });

      expect(picker.closest('[data-open]')).toHaveAttribute('data-open', 'false');
      expect(picker).toHaveTextContent(/^Claude Code$/);
      expect(getLaunchButton()).toHaveTextContent('Launch ↵');
    });

    it('keeps a menu closed when its control goes away while open and comes back', async () => {
      const user = userEvent.setup();
      mockPresetStore.presets = [
        {
          id: 'preset-1',
          name: 'Claude Code',
          openCommand: 'claude',
          promptCommand: 'claude {{prompt}}',
          launchModes: [],
          reasoningLevels: [{ id: 'r-low', name: 'Low', arguments: '--effort low' }],
        },
        {
          id: 'preset-2',
          name: 'Codex',
          openCommand: 'codex',
          promptCommand: 'codex {{prompt}}',
          launchModes: [],
        },
      ];
      mockPresetStore.activePreset = mockPresetStore.presets[0];
      mockPresetStore.activePresets = [
        { presetId: 'preset-1', lastUsedAt: 200 },
        { presetId: 'preset-2', lastUsedAt: 100 },
      ];
      render(<NewWorkspaceDialog open={true} onOpenChange={vi.fn()} />);
      const textarea = await screen.findByPlaceholderText(/what should the agent work on/i);
      await user.click(screen.getByRole('button', { name: 'Claude Code Effort: Default' }));

      fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });
      expect(screen.queryByRole('button', { name: /Effort/ })).not.toBeInTheDocument();
      fireEvent.keyDown(textarea, { key: '.', ctrlKey: true });

      expect(
        screen.getByRole('button', { name: 'Claude Code Effort: Default' }).closest('[data-open]')
      ).toHaveAttribute('data-open', 'false');
    });

    it('opens the dialog shortcuts in Settings from the agent menu', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      useSettingsDialogStore.setState({ open: false, target: {} });
      usePresetWithModeAndEffort();
      render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);
      await screen.findByPlaceholderText(/what should the agent work on/i);

      const agentPill = screen.getByTitle(/click to select launch mode/i);
      await user.click(agentPill);
      await user.click(screen.getByRole('button', { name: 'Customize shortcuts' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      // Closed as any other close would, so the menu doesn't reopen with the dialog.
      expect(agentPill.closest('[data-open]')).toHaveAttribute('data-open', 'false');
      expect(useSettingsDialogStore.getState()).toMatchObject({
        open: true,
        target: { tab: 'shortcuts', card: 'New workspace dialog' },
      });
    });
  });
});
