/**
 * @vitest-environment jsdom
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OnboardingConnectStep,
  useAgentConnections,
} from '../../../../src/renderer/components/layout/OnboardingConnectStep';

import type { AgentConnection } from '../../../../src/renderer/components/layout/OnboardingConnectStep';

const claude = {
  name: 'Claude Code',
  label: 'Claude Code',
  preset: { name: 'Claude Code', openCommand: 'claude' },
  filter: 'claude' as const,
};
const codex = {
  name: 'Codex',
  label: 'Codex',
  preset: { name: 'Codex', openCommand: 'codex' },
  filter: 'codex' as const,
};
const cursor = {
  name: 'Cursor CLI',
  label: 'Cursor CLI',
  preset: { name: 'Cursor CLI', openCommand: 'agent' },
};

function setupApi({ claudeNotifications = false, codexNotifications = false } = {}) {
  const api = {
    websiteUrl: 'https://komla.dev',
    getNotificationHookDetails: vi.fn().mockResolvedValue({
      isConfigured: claudeNotifications,
      settingsPath: '/home/me/.claude/settings.json',
    }),
    getCodexNotificationHookDetails: vi.fn().mockResolvedValue({
      isConfigured: codexNotifications,
      settingsPath: '/home/me/.codex/hooks.json',
    }),
    getOpenCodeNotificationHookDetails: vi.fn().mockResolvedValue({
      isConfigured: false,
      pluginPath: '/home/me/.config/opencode/plugins/komla.ts',
    }),
    getKomlaSkillStatus: vi.fn(),
    enableNotifications: vi.fn().mockResolvedValue(undefined),
    disableNotifications: vi.fn().mockResolvedValue(undefined),
    enableCodexNotifications: vi.fn().mockResolvedValue(undefined),
    enableOpenCodeNotifications: vi.fn().mockResolvedValue(undefined),
    enableKomlaSkill: vi.fn(),
  };
  window.api = api as unknown as typeof window.api;
  return api;
}

describe('useAgentConnections', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('checks nothing until enabled', async () => {
    const api = setupApi();
    const { result, rerender } = renderHook(
      ({ enabled }) => useAgentConnections(['claude'], enabled),
      { initialProps: { enabled: false } }
    );
    expect(result.current.connections).toBeNull();
    expect(api.getNotificationHookDetails).not.toHaveBeenCalled();
    expect(api.getKomlaSkillStatus).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.connections).not.toBeNull());
  });

  it('leaves the Komla skill to Tips', async () => {
    const api = setupApi();
    const { result } = renderHook(() => useAgentConnections(['claude'], true));
    await waitFor(() => expect(result.current.connections).not.toBeNull());

    expect(api.getKomlaSkillStatus).not.toHaveBeenCalled();
  });

  it('turns on only the integration asked for', async () => {
    const api = setupApi();
    const { result } = renderHook(() => useAgentConnections(['claude', 'codex', 'opencode'], true));
    await waitFor(() => expect(result.current.connections).toHaveLength(3));

    await act(() => result.current.toggle('codex', true));

    expect(api.enableCodexNotifications).toHaveBeenCalledOnce();
    expect(api.enableKomlaSkill).not.toHaveBeenCalled();
    expect(api.enableNotifications).not.toHaveBeenCalled();
    expect(api.enableOpenCodeNotifications).not.toHaveBeenCalled();
  });

  it('turns notifications off', async () => {
    const api = setupApi({ claudeNotifications: true });
    const { result } = renderHook(() => useAgentConnections(['claude'], true));
    await waitFor(() => expect(result.current.connections).not.toBeNull());

    await act(() => result.current.toggle('claude', false));

    expect(api.disableNotifications).toHaveBeenCalledOnce();
  });

  it('shows the new state once the change is made', async () => {
    const api = setupApi();
    const { result } = renderHook(() => useAgentConnections(['claude'], true));
    await waitFor(() => expect(result.current.connections).not.toBeNull());
    api.getNotificationHookDetails.mockResolvedValue({
      isConfigured: true,
      settingsPath: '/home/me/.claude/settings.json',
    });

    await act(() => result.current.toggle('claude', true));

    expect(result.current.connections?.[0]).toMatchObject({ notifications: true, changes: [] });
    expect(result.current.pending).toBeNull();
    expect(result.current.errors).toEqual({});
  });

  it('keeps what failed for that agent', async () => {
    const api = setupApi();
    api.enableNotifications.mockRejectedValue(
      new Error(
        "Error invoking remote method 'notifications:enable': Error: settings.json is invalid"
      )
    );
    const { result } = renderHook(() => useAgentConnections(['claude', 'codex'], true));
    await waitFor(() => expect(result.current.connections).not.toBeNull());

    await act(() => result.current.toggle('claude', true));
    expect(result.current.errors).toEqual({
      claude: 'Couldn’t turn on hooks: settings.json is invalid',
    });
    expect(result.current.pending).toBeNull();
  });
});

function connection(agent: AgentConnection['agent'], notifications: boolean): AgentConnection {
  return {
    agent,
    notifications,
    changes: notifications
      ? []
      : [{ label: 'Hooks in', value: `/home/me/.${agent}/settings.json` }],
  };
}

function renderStep(props: Partial<Parameters<typeof OnboardingConnectStep>[0]> = {}) {
  const defaults = {
    agents: [claude, codex],
    others: [cursor],
    connections: [connection('claude', true), connection('codex', false)],
    pending: null,
    errors: {},
    onToggle: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  render(<OnboardingConnectStep {...merged} />);
  return merged;
}

describe('OnboardingConnectStep', () => {
  beforeEach(() => {
    setupApi();
  });

  it('gives each agent a hooks switch, and nothing else', () => {
    const props = renderStep();

    expect(screen.getByRole('heading', { name: 'Connect your agents' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Claude Code Hooks' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Codex Hooks' })).not.toBeChecked();
    expect(screen.getAllByRole('switch')).toHaveLength(2);

    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code Hooks' }));
    expect(props.onToggle).toHaveBeenCalledWith('claude', false);
  });

  it('explains what each switch does on request', async () => {
    renderStep();

    fireEvent.click(screen.getByRole('button', { name: 'About Claude Code hooks' }));
    expect(
      await screen.findByText(/Recent Claude Code versions tell Komla when they finish/)
    ).toBeVisible();
  });

  it('says notifications work without hooks only when every agent reports its own status', () => {
    renderStep({ others: [] });
    expect(screen.getByText(/They already tell Komla when they finish or need you/)).toBeVisible();
  });

  it('says hooks bring notifications when an agent may not report its own status', () => {
    renderStep();
    expect(screen.getByText(/Leave agents running and come back when one needs you/)).toBeVisible();
  });

  it('waits on other changes while one runs', () => {
    renderStep({ pending: 'claude' });

    for (const name of ['Claude Code Hooks', 'Codex Hooks']) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
  });

  it("shows what failed on the agent's row", () => {
    renderStep({ errors: { codex: 'Couldn’t turn on hooks: permission denied' } });

    expect(
      within(screen.getByRole('list', { name: 'Agents with one-click setup' })).getAllByRole(
        'listitem'
      )[1]
    ).toHaveTextContent('Couldn’t turn on hooks: permission denied.');
  });

  it('points at Tips for the Komla skill', () => {
    renderStep({ agents: [], others: [cursor], connections: [] });

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'What changes?' })).toBeNull();
    expect(
      screen.getByText(/To teach your agents about it, install the Komla skill from Tips later/)
    ).toBeVisible();
  });

  it('shows what turning things on changes, on request', () => {
    renderStep();
    const toggle = screen.getByRole('button', { name: 'What changes?' });
    expect(screen.queryByText('/home/me/.codex/settings.json')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/home/me/.codex/settings.json')).toBeVisible();
    expect(screen.queryByText('/home/me/.claude/settings.json')).toBeNull();
  });

  it('points agents that set themselves up at Tips, without starting anything', () => {
    renderStep();

    const note = screen.getByRole('note', { name: 'Cursor CLI can set itself up' });
    expect(note).toHaveTextContent(
      'Komla can’t connect it for you. After setup, open Tips and run “Integrate Cursor CLI with Komla”. Komla starts the agent with a setup prompt, and it adds Komla’s hooks itself, asking before it changes a file.'
    );
    expect(screen.queryByRole('button', { name: /^Set up/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names a few of the agents that set themselves up', () => {
    const named = (name: string) => ({ name, label: name, preset: { name, openCommand: name } });
    renderStep({ others: [cursor, named('Pi'), named('Amp'), named('Grok Build')] });

    expect(
      screen.getByRole('note', { name: 'Cursor CLI, Pi, and 2 others can set themselves up' })
    ).toHaveTextContent(
      'run “Integrate Cursor CLI, Pi, and 2 others with Komla”. Komla starts each agent with a setup prompt'
    );
  });

  it('links the Komla CLI docs', () => {
    renderStep();

    expect(screen.getByRole('link', { name: 'CLI docs ↗' })).toHaveAttribute(
      'href',
      'https://komla.dev/komla-cli'
    );
  });
});
