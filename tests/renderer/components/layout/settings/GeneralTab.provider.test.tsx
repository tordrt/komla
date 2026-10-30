/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as unknown as { window: Window }).window.api = {
    platform: 'darwin',
    websiteUrl: 'https://komla.dev',
    getBasePath: () => Promise.resolve('/home/user/.komla'),
  } as unknown as typeof window.api;
});

vi.mock('../../../../../src/renderer/components/layout/settings/SettingsHistoryCard', () => ({
  SettingsHistoryCard: () => null,
}));

vi.mock('../../../../../src/renderer/components/layout/settings/WorkspaceTagsCard', () => ({
  WorkspaceTagsCard: () => null,
}));

import { GeneralTab } from '../../../../../src/renderer/components/layout/settings/GeneralTab';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';

import {
  DEFAULT_COMMIT_MESSAGE_PROMPT,
  DEFAULT_WORKSPACE_NAMING_PROMPT,
} from '../../../../../src/shared/constants/utility-prompts';

import type { AppConfig } from '../../../../../src/renderer/types';

function renderGeneralTab() {
  useConfigStore.setState({
    config: { utilityProvider: 'komla-managed' } as AppConfig,
    openRouterKeyStatus: { hasKey: false } as never,
  });
  render(<GeneralTab onClose={vi.fn()} />);
}

describe('GeneralTab AI helper provider', () => {
  beforeEach(() => {
    window.api.managedAiHelpers = true;
  });

  afterEach(() => {
    useConfigStore.setState(useConfigStore.getInitialState(), true);
  });

  it('offers Komla managed in a build with the managed AI helpers', () => {
    renderGeneralTab();

    expect(screen.getByRole('option', { name: 'Komla managed' })).not.toBeDisabled();
  });

  it('disables Komla managed and says why in a build without them', () => {
    window.api.managedAiHelpers = false;
    renderGeneralTab();

    expect(screen.getByRole('option', { name: 'Komla managed' })).toBeDisabled();
    expect(screen.getByText(/only in official builds/)).toBeInTheDocument();
  });

  it('marks the provider to change in a build without them', () => {
    window.api.managedAiHelpers = false;
    renderGeneralTab();

    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveClass('border-warning');
    expect(screen.getByText(/only in official builds/)).toHaveClass('text-warning');
  });

  it('leaves the provider unmarked in a build with them', () => {
    renderGeneralTab();

    expect(screen.getByRole('combobox', { name: 'Provider' })).not.toHaveClass('border-warning');
    expect(screen.getByText(/Free, on us/)).not.toHaveClass('text-warning');
  });
});

describe('GeneralTab custom endpoint prompts', () => {
  const updateConfig = vi.fn();

  function renderCustom(saved: Partial<AppConfig> = {}) {
    updateConfig.mockImplementation(async (updates: Partial<AppConfig>) => {
      useConfigStore.setState((state) => ({
        config: { ...state.config, ...updates } as AppConfig,
      }));
      return { ok: true };
    });
    useConfigStore.setState({
      config: { utilityProvider: 'custom', ...saved } as AppConfig,
      openRouterKeyStatus: { hasKey: false } as never,
      updateConfig,
    });
    render(<GeneralTab onClose={vi.fn()} />);
  }

  const editor = (name: string) => within(screen.getByRole('group', { name }));

  it('leaves the provider unmarked once chosen in a build without the managed AI helpers', () => {
    window.api.managedAiHelpers = false;
    renderCustom();

    expect(screen.getByRole('combobox', { name: 'Provider' })).not.toHaveClass('border-warning');
  });

  afterEach(() => {
    updateConfig.mockReset();
    useConfigStore.setState(useConfigStore.getInitialState(), true);
  });

  it('shows the default prompts, with nothing to reset', () => {
    renderCustom();

    expect(editor('Workspace naming prompt').getByRole('textbox')).toHaveValue(
      DEFAULT_WORKSPACE_NAMING_PROMPT
    );
    expect(editor('Commit message prompt').getByRole('textbox')).toHaveValue(
      DEFAULT_COMMIT_MESSAGE_PROMPT
    );
    for (const name of ['Workspace naming prompt', 'Commit message prompt']) {
      expect(editor(name).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
    }
  });

  it('saves an edited prompt, and saves none once it matches the default again', async () => {
    renderCustom();
    const box = editor('Workspace naming prompt').getByRole('textbox');

    fireEvent.change(box, { target: { value: 'Name it' } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ workspaceNamingPrompt: 'Name it' })
    );

    fireEvent.change(box, { target: { value: `${DEFAULT_WORKSPACE_NAMING_PROMPT}\n` } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(updateConfig).toHaveBeenLastCalledWith({ workspaceNamingPrompt: '' })
    );
  });

  it('resets a saved prompt to the default', async () => {
    renderCustom({ commitMessagePrompt: 'Use gitmoji' });
    const commit = editor('Commit message prompt');
    expect(commit.getByRole('textbox')).toHaveValue('Use gitmoji');

    fireEvent.click(commit.getByRole('button', { name: 'Reset to default' }));

    expect(updateConfig).toHaveBeenCalledWith({ commitMessagePrompt: '' });
    await waitFor(() =>
      expect(commit.getByRole('textbox')).toHaveValue(DEFAULT_COMMIT_MESSAGE_PROMPT)
    );
  });

  it('leaves the prompts out for Komla managed', () => {
    renderGeneralTab();

    expect(screen.queryByRole('group', { name: 'Workspace naming prompt' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Commit message prompt' })).toBeNull();
  });
});
