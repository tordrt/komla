/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTab } from '../../../../../src/renderer/components/layout/settings/AgentTab';

const mockCreatePreset = vi.fn();
const mockAddActivePreset = vi.fn();
const mockUpdatePreset = vi.fn();
const mockDeletePreset = vi.fn();
const mockRemoveActivePreset = vi.fn();
const mockReorderPreset = vi.fn();
const mockLoadTemplates = vi.fn().mockResolvedValue(undefined);
const mockAddToast = vi.fn();

const shellOnlyTemplate = {
  name: 'Shell Only',
  openCommand: '',
  continueCommand: '',
  promptCommand: '',
  launchModes: [],
  isBuiltin: true,
};

const claudeLevels = [
  { id: 'level-low', name: 'Low', arguments: '--effort low' },
  { id: 'level-high', name: 'High', arguments: '--effort high' },
];

const claudeTemplate = {
  name: 'Claude Code',
  openCommand: 'claude {{launchMode}}',
  continueCommand: 'claude --resume',
  promptCommand: 'claude --prompt',
  launchModes: [{ id: 'mode-plan', name: 'Plan', arguments: '--permission-mode plan' }],
  reasoningLevels: claudeLevels,
  isBuiltin: true,
};

const cursorTemplate = {
  name: 'Cursor CLI',
  openCommand: 'cursor-agent {{launchMode}}',
  continueCommand: 'cursor-agent --continue',
  promptCommand: 'cursor-agent {{prompt}}',
  launchModes: [],
  isBuiltin: true,
};

const codexTemplate = {
  name: 'Codex',
  openCommand: 'codex {{launchMode}}',
  continueCommand: 'codex resume --last',
  promptCommand: 'codex {{prompt}}',
  launchModes: [],
  isBuiltin: true,
};

const existingPreset = {
  id: 'preset-1',
  name: 'Gemini',
  openCommand: 'gemini',
  continueCommand: 'gemini --resume latest',
  promptCommand: 'gemini -- {{prompt}}',
  launchModes: [],
  isBuiltin: false,
};

const customTemplate = {
  name: 'Custom',
  openCommand: '',
  continueCommand: '',
  promptCommand: '',
  launchModes: [],
  isBuiltin: true,
};

let mockTemplates: any[] = [];
let mockPresets: any[] = [];
let mockActivePresets: any[] = [];

vi.mock('../../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({
    presets: mockPresets,
    templates: mockTemplates,
    activePresets: mockActivePresets,
    loadTemplates: mockLoadTemplates,
    createPreset: mockCreatePreset,
    updatePreset: mockUpdatePreset,
    deletePreset: mockDeletePreset,
    reorderPreset: mockReorderPreset,
    addActivePreset: mockAddActivePreset,
    removeActivePreset: mockRemoveActivePreset,
  }),
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector?: (state: { addToast: typeof mockAddToast }) => unknown) => {
    const state = { addToast: mockAddToast };
    return selector ? selector(state) : state;
  },
}));

// AgentIntegrationsPanel is rendered in list view; stub it out so the test
// doesn't have to mock its config/IPC dependencies.
vi.mock('../../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../../../src/renderer/components/layout/settings/AgentIntegrations', () => ({
  AgentIntegrationsPanel: ({ agentFilter }: { agentFilter: string }) => (
    <p>Integrations for {agentFilter}</p>
  ),
}));

describe('AgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTemplates = [claudeTemplate, shellOnlyTemplate, customTemplate];
    mockPresets = [];
    mockActivePresets = [];
    mockCreatePreset.mockResolvedValue({ ...shellOnlyTemplate, id: 'new-shell-id' });
    mockAddActivePreset.mockResolvedValue(undefined);
    mockDeletePreset.mockResolvedValue(undefined);
    mockReorderPreset.mockResolvedValue(undefined);
    (window as unknown as { api: unknown }).api = {
      getMcpStatus: vi.fn().mockResolvedValue({ generic: { integrationPrompt: 'prompt' } }),
      getNotificationHookDetails: vi
        .fn()
        .mockResolvedValue({ isConfigured: false, settingsPath: '~/.claude/settings.json' }),
      enableNotifications: vi.fn().mockResolvedValue(undefined),
      getCodexNotificationHookDetails: vi.fn().mockResolvedValue({
        isConfigured: false,
        settingsPath: '~/.codex/hooks.json',
        hasConflict: false,
        canAutoConfigure: true,
        conflictMessage: null,
      }),
      enableCodexNotifications: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue({}),
      showMessageBox: vi.fn().mockResolvedValue(1),
    };
  });

  it('adds Shell Only directly without showing the edit form', async () => {
    const user = userEvent.setup();
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Shell Only/i }));

    await waitFor(() => {
      expect(mockCreatePreset).toHaveBeenCalledWith({
        name: 'Shell Only',
        openCommand: '',
        continueCommand: '',
        promptCommand: '',
        launchModes: [],
        isBuiltin: false,
      });
    });
    expect(mockAddActivePreset).toHaveBeenCalledWith('new-shell-id');
    expect(mockAddToast).toHaveBeenCalledWith('Shell Only preset added', 'success');

    // Returned to the list view — the template picker is gone.
    expect(screen.queryByRole('button', { name: /^Shell Only/i })).not.toBeInTheDocument();
    // Edit form (Open Command field) was never shown.
    expect(screen.queryByLabelText(/Open Command/i)).not.toBeInTheDocument();
  });

  it('opens the edit form for non-Shell-Only templates with the commands collapsed', async () => {
    const user = userEvent.setup();
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));

    // No direct-add side effects.
    expect(mockCreatePreset).not.toHaveBeenCalled();
    expect(mockAddActivePreset).not.toHaveBeenCalled();
    // The name shows with a summary of the commands, which sit behind "Customize".
    expect(screen.getByLabelText('Display name')).toHaveValue('Claude Code');
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Low · High')).toBeInTheDocument();
    expect(screen.getByDisplayValue('claude --resume').closest('[inert]')).not.toBeNull();

    const customize = screen.getByRole('button', { name: 'Customize', expanded: false });
    await user.click(customize);

    // The same button stays, so keyboard focus stays on it.
    expect(customize).toHaveAttribute('aria-expanded', 'true');
    expect(customize).toHaveFocus();
    expect(screen.queryByText('Low · High')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('claude --resume').closest('[inert]')).toBeNull();
    expect(
      screen.getByText('Command to resume or choose an existing session in this worktree')
    ).toBeInTheDocument();
  });

  it('warns about best-effort commands while they are collapsed', async () => {
    const user = userEvent.setup();
    mockTemplates = [claudeTemplate, cursorTemplate];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Cursor CLI/i }));

    expect(screen.getByRole('button', { name: 'Customize', expanded: false })).toBeVisible();
    expect(screen.getByText(/Best-effort defaults/)).toBeInTheDocument();
  });

  it('opens the collapsed commands when one of them fails to save', async () => {
    const user = userEvent.setup();
    mockTemplates = [
      { ...claudeTemplate, launchModes: [{ id: 'unnamed', name: '', arguments: '--x' }] },
    ];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByText('Every launch mode must have a name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customize', expanded: true })).toBeVisible();
    expect(screen.getByDisplayValue('--x').closest('[inert]')).toBeNull();
  });

  it('colors summary modes by their place in the full list', async () => {
    const user = userEvent.setup();
    mockTemplates = [
      {
        ...claudeTemplate,
        launchModes: [
          { id: 'blank', name: '', arguments: '' },
          { id: 'mode-plan', name: 'Plan', arguments: '--permission-mode plan' },
        ],
      },
    ];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));

    // The editor colors the second mode purple, so the summary must too.
    expect(screen.getByText('Plan').querySelector('.bg-purple-500')).not.toBeNull();
  });

  it('turns on notifications when a new built-in agent is saved, not before', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockImplementation(async (data: any) => {
      const preset = { ...data, id: 'claude-id' };
      mockPresets.push(preset);
      return preset;
    });
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));

    const notifications = await screen.findByRole('switch', { name: 'Hooks' });
    await waitFor(() => expect(notifications).toBeEnabled());
    expect(notifications).toBeChecked();
    // The integration panel waits for the saved preset; the switch stands in for it.
    expect(screen.queryByText('Integrations for claude')).not.toBeInTheDocument();
    expect(window.api.enableNotifications).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(window.api.enableNotifications).toHaveBeenCalledTimes(1));
    expect(mockCreatePreset).toHaveBeenCalled();
    expect(await screen.findByText('Integrations for claude')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hooks' })).not.toBeInTheDocument();
  });

  it('leaves notifications off when the switch is turned off', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'claude-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));
    const notifications = await screen.findByRole('switch', { name: 'Hooks' });
    await waitFor(() => expect(notifications).toBeEnabled());
    await user.click(notifications);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalled());
    expect(window.api.enableNotifications).not.toHaveBeenCalled();
  });

  it('says notifications are already on instead of offering the switch', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.getNotificationHookDetails).mockResolvedValue({
      isConfigured: true,
      settingsPath: '~/.claude/settings.json',
    } as never);
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'claude-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));

    expect(await screen.findByText('Already on')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hooks' })).not.toBeInTheDocument();
    // No label left pointing at the missing switch.
    expect(screen.getByText('Hooks').closest('label')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalled());
    expect(window.api.enableNotifications).not.toHaveBeenCalled();
  });

  it('keeps the saved preset and reports it when notifications fail to turn on', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.enableNotifications).mockRejectedValue(
      new Error('settings.json is locked')
    );
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'claude-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));
    const notifications = await screen.findByRole('switch', { name: 'Hooks' });
    await waitFor(() => expect(notifications).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        'Agent preset saved. Couldn’t turn on hooks: settings.json is locked',
        'error'
      )
    );
    // One message for both, not an error followed by a success.
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddActivePreset).toHaveBeenCalledWith('claude-id');
  });

  it('waits for the notification status before Save can turn them on', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.getNotificationHookDetails).mockReturnValue(new Promise(() => {}));
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'claude-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));

    expect(screen.getByRole('switch', { name: 'Hooks' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalled());
    expect(window.api.enableNotifications).not.toHaveBeenCalled();
  });

  it('leaves conflicting Codex notifications to the integration panel', async () => {
    const user = userEvent.setup();
    mockTemplates = [codexTemplate];
    vi.mocked(window.api.getCodexNotificationHookDetails).mockResolvedValue({
      isConfigured: false,
      settingsPath: '~/.codex/hooks.json',
      hasConflict: true,
      canAutoConfigure: false,
      conflictMessage: 'hooks.json is not valid JSON',
    } as never);
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'codex-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Codex/i }));

    expect(await screen.findByText(/Set them up below after saving/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hooks' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockCreatePreset).toHaveBeenCalled());
    expect(window.api.enableCodexNotifications).not.toHaveBeenCalled();
  });

  it('drops the Codex hooks hint when its notifications are switched off', async () => {
    const user = userEvent.setup();
    mockTemplates = [codexTemplate];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Codex/i }));
    const notifications = await screen.findByRole('switch', { name: 'Hooks' });
    await waitFor(() => expect(notifications).toBeEnabled());
    expect(screen.getByText(/run/)).toHaveTextContent('/hooks');

    await user.click(notifications);

    expect(screen.queryByText('/hooks')).not.toBeInTheDocument();
  });

  it('offers no notifications switch for agents without one-click setup', async () => {
    const user = userEvent.setup();
    mockTemplates = [cursorTemplate];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Cursor CLI/i }));

    expect(screen.queryByRole('switch', { name: 'Hooks' })).not.toBeInTheDocument();
  });

  it('shows every field when editing an existing preset', async () => {
    const user = userEvent.setup();
    mockPresets = [existingPreset];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));

    expect(screen.queryByRole('button', { name: /Customize/ })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('gemini --resume latest').closest('[inert]')).toBeNull();
  });

  it('renders active presets in preset order and reorders with move buttons', async () => {
    const user = userEvent.setup();
    mockPresets = [
      { id: 'preset-1', name: 'Claude Code', launchModes: [] },
      { id: 'preset-2', name: 'Codex', launchModes: [] },
    ];
    mockActivePresets = [
      { presetId: 'preset-2', lastUsedAt: 200 },
      { presetId: 'preset-1', lastUsedAt: 100 },
    ];

    render(<AgentTab onClose={vi.fn()} />);

    const rows = screen
      .getAllByRole('button', { name: 'Edit preset' })
      .map(
        (button) =>
          button.closest('.flex.items-center.justify-between')?.querySelector('.font-medium')
            ?.textContent
      );
    expect(rows).toEqual(['Claude Code', 'Codex']);

    await user.click(screen.getAllByRole('button', { name: 'Move preset down' })[0]);

    expect(mockReorderPreset).toHaveBeenCalledWith('preset-1', 1);
  });

  it('permanently deletes a preset from the catalog after confirmation', async () => {
    const user = userEvent.setup();
    mockPresets = [
      { id: 'preset-1', name: 'Claude Code', launchModes: [] },
      { id: 'preset-2', name: 'Copilot', launchModes: [] },
    ];
    mockActivePresets = [
      { presetId: 'preset-1', lastUsedAt: 200 },
      { presetId: 'preset-2', lastUsedAt: 100 },
    ];

    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getAllByRole('button', { name: 'Delete preset' })[1]);

    await waitFor(() => expect(mockDeletePreset).toHaveBeenCalledWith('preset-2'));
    expect(mockRemoveActivePreset).not.toHaveBeenCalled();
  });

  it('keeps a custom preset in the edit view after first save and shows the self-integration callout', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockImplementation(async (data: any) => {
      const preset = { ...data, id: 'custom-id' };
      mockPresets.push(preset);
      return preset;
    });
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Custom/i }));

    // The callout is hidden while the preset is still unsaved.
    expect(screen.queryByText(/No prebuilt one-click integration/i)).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('e.g., claude {{launchMode}}'), 'aider');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    // After the first save we stay in the edit view, and the self-integration
    // callout now appears against the saved, launchable preset.
    expect(
      await screen.findByRole('heading', {
        name: 'No prebuilt one-click integration for aider yet?',
      })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., claude {{launchMode}}')).toBeInTheDocument();
    expect(mockCreatePreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'aider', openCommand: 'aider' })
    );
  });

  it('keeps a built-in template preset in the edit view after first save', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockImplementation(async (data: any) => {
      const preset = { ...data, id: 'claude-id' };
      mockPresets.push(preset);
      return preset;
    });
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    // After the first save we stay in the edit view rather than returning to
    // the list, so the inline agent integration controls stay reachable. The
    // commands stay collapsed.
    expect(
      await screen.findByRole('button', { name: 'Customize', expanded: false })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add preset/i })).not.toBeInTheDocument();
  });

  it('saves new launch modes as reusable arguments', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockResolvedValue({ ...customTemplate, id: 'custom-id' });
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Custom/i }));
    await user.type(screen.getByPlaceholderText('e.g., claude {{launchMode}}'), 'claude');
    await user.click(screen.getByRole('button', { name: /Add mode/i }));
    await user.type(screen.getByPlaceholderText('e.g., Plan'), 'Plan');
    await user.type(screen.getByPlaceholderText('e.g., --permission-mode plan'), '--plan');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(mockCreatePreset).toHaveBeenCalledWith(
      expect.objectContaining({
        launchModes: [expect.objectContaining({ name: 'Plan', arguments: '--plan' })],
      })
    );
  });

  it('keeps the template effort levels when adding a built-in agent', async () => {
    const user = userEvent.setup();
    mockCreatePreset.mockImplementation(async (data: any) => ({ ...data, id: 'claude-id' }));
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Add preset/i }));
    await user.click(screen.getByRole('button', { name: /Claude Code/i }));
    expect(screen.getByDisplayValue('--effort high')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(mockCreatePreset).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Claude Code', reasoningLevels: claudeLevels })
    );
  });

  it('saves effort levels added to an existing preset', async () => {
    const user = userEvent.setup();
    mockPresets = [existingPreset];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    mockUpdatePreset.mockResolvedValue(existingPreset);
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByRole('button', { name: /Add level/i }));
    await user.type(screen.getByPlaceholderText('e.g., High'), ' High ');
    await user.type(screen.getByPlaceholderText('e.g., --effort high'), '--thinking high ');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(mockUpdatePreset).toHaveBeenCalledWith(
      'preset-1',
      expect.objectContaining({
        reasoningLevels: [
          { id: expect.any(String), name: 'High', arguments: '--thinking high' },
        ],
      })
    );
  });

  it('removes effort levels from an existing preset', async () => {
    const user = userEvent.setup();
    mockPresets = [{ ...existingPreset, reasoningLevels: claudeLevels }];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    mockUpdatePreset.mockResolvedValue(existingPreset);
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByTitle('Remove effort level Low'));
    await user.click(screen.getByTitle('Remove effort level High'));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(mockUpdatePreset).toHaveBeenCalledWith(
      'preset-1',
      expect.objectContaining({ reasoningLevels: [] })
    );
  });

  it('leaves effort levels untouched when saving other changes', async () => {
    const user = userEvent.setup();
    mockPresets = [existingPreset];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    mockUpdatePreset.mockResolvedValue(existingPreset);
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockUpdatePreset).toHaveBeenCalled());
    expect(mockUpdatePreset.mock.calls[0][1]).not.toHaveProperty('reasoningLevels');
    expect(mockUpdatePreset.mock.calls[0][1]).not.toHaveProperty('levelPicker');
  });

  it('saves the level picker title, and a cleared one as the default', async () => {
    const user = userEvent.setup();
    mockPresets = [{ ...existingPreset, levelPicker: { title: 'Model', icon: 'cpu' } }];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    mockUpdatePreset.mockResolvedValue(existingPreset);
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    const title = screen.getByRole('textbox', { name: 'Picker title' });
    await user.clear(title);
    await user.type(title, ' Speed ');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockUpdatePreset).toHaveBeenLastCalledWith(
      'preset-1',
      expect.objectContaining({ levelPicker: { title: 'Speed', icon: 'cpu' } })
    );

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.clear(screen.getByRole('textbox', { name: 'Picker title' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockUpdatePreset).toHaveBeenLastCalledWith(
      'preset-1',
      expect.objectContaining({ levelPicker: { icon: 'cpu' } })
    );
  });

  it('saves a hidden level picker, keeping its levels', async () => {
    const user = userEvent.setup();
    mockPresets = [{ ...existingPreset, reasoningLevels: claudeLevels }];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    mockUpdatePreset.mockResolvedValue(existingPreset);
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByRole('switch', { name: 'Show in the new workspace dialog' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockUpdatePreset).toHaveBeenCalled());
    expect(mockUpdatePreset.mock.calls[0][1]).toMatchObject({ levelPicker: { hidden: true } });
    expect(mockUpdatePreset.mock.calls[0][1]).not.toHaveProperty('reasoningLevels');
  });

  it('requires each effort level to have its own name', async () => {
    const user = userEvent.setup();
    mockPresets = [{ ...existingPreset, reasoningLevels: claudeLevels }];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByRole('button', { name: /Add level/i }));
    const names = screen.getAllByPlaceholderText('e.g., High');
    await user.type(names[names.length - 1], ` ${claudeLevels[0].name} `);
    const args = screen.getAllByPlaceholderText('e.g., --effort high');
    await user.type(args[args.length - 1], '--other');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByText('Every effort level needs its own name')).toBeInTheDocument();
    expect(mockUpdatePreset).not.toHaveBeenCalled();
  });

  it.each([
    ['e.g., --effort high', '--thinking high'],
    ['e.g., High', 'High'],
  ])('requires both a name and arguments for effort levels (%s filled)', async (placeholder, value) => {
    const user = userEvent.setup();
    mockPresets = [existingPreset];
    mockActivePresets = [{ presetId: 'preset-1', lastUsedAt: 100 }];
    render(<AgentTab onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Edit preset' }));
    await user.click(screen.getByRole('button', { name: /Add level/i }));
    await user.type(screen.getByPlaceholderText(placeholder), value);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(
      await screen.findByText('Every effort level needs a name and arguments')
    ).toBeInTheDocument();
    expect(mockUpdatePreset).not.toHaveBeenCalled();
  });
});
