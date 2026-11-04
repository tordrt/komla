/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PluginSettingsForm } from '../../../../../src/renderer/components/layout/settings/PluginSettingsForm';

import type { PluginInfo } from '../../../../../src/shared/types/plugins';

const plugin: PluginInfo = {
  id: 'prs',
  name: 'Pull requests',
  folder: 'prs',
  state: 'on',
  contributions: [],
  settings: [
    { id: 'repo', title: 'Repository', type: 'text', value: 'cli/cli' },
    { id: 'limit', title: 'Limit', type: 'number', default: 30 },
    { id: 'drafts', title: 'Show drafts', type: 'boolean', default: true },
    {
      id: 'sort',
      title: 'Sort',
      type: 'choice',
      options: ['updated', 'created'],
    },
    { id: 'token', title: 'Token', type: 'secret', isSet: true },
  ],
  secretStorage: 'keychain',
};

function setup(info = plugin) {
  const onSave = vi.fn(async () => true);
  render(<PluginSettingsForm plugin={info} onSave={onSave} />);
  return { onSave, user: userEvent.setup() };
}

describe('PluginSettingsForm', () => {
  beforeAll(() => {
    // The switch measures itself.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('shows each setting as set, and a secret only as set', () => {
    setup();

    expect(screen.getByLabelText('Repository')).toHaveValue('cli/cli');
    expect(screen.getByLabelText('Limit')).toHaveAttribute('placeholder', '30');
    expect(screen.getByLabelText('Show drafts')).toBeChecked();
    expect(screen.getByLabelText('Token')).toHaveValue('');
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Token')).toHaveAttribute(
      'placeholder',
      'Set. Type a new one to replace it'
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves only what the user changed', async () => {
    const { onSave, user } = setup();

    await user.clear(screen.getByLabelText('Repository'));
    await user.type(screen.getByLabelText('Repository'), 'cli/go-gh');
    await user.type(screen.getByLabelText('Limit'), '10');
    await user.click(screen.getByLabelText('Show drafts'));
    await user.selectOptions(screen.getByLabelText('Sort'), 'created');
    await user.type(screen.getByLabelText('Token'), 'ghp_new');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      repo: 'cli/go-gh',
      limit: 10,
      drafts: false,
      sort: 'created',
      token: 'ghp_new',
    });
    // Saved, so there's nothing left to save.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('keeps the secret when the user erases what they typed, and clears it with Clear', async () => {
    const { onSave, user } = setup();

    await user.type(screen.getByLabelText('Token'), 'oops');
    await user.clear(screen.getByLabelText('Token'));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({ token: null });
  });

  it('still clears the secret when the user types a new one after Clear and erases it', async () => {
    const { onSave, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.type(screen.getByLabelText('Token'), 'x');
    await user.clear(screen.getByLabelText('Token'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({ token: null });
  });

  it('keeps what the user changes while it saves, and saves once', async () => {
    let finish: (saved: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(<PluginSettingsForm plugin={plugin} onSave={onSave} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Token'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.type(screen.getByLabelText('Repository'), '-x{Enter}');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => finish(true));

    expect(screen.getByLabelText('Repository')).toHaveValue('cli/cli-x');
    // The Clear pressed while saving still holds after typing a secret and erasing it.
    await user.type(screen.getByLabelText('Token'), 'y');
    await user.clear(screen.getByLabelText('Token'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith({ repo: 'cli/cli-x', token: null });
  });

  it('says where secrets are kept on a computer without a keychain', () => {
    setup({ ...plugin, secretStorage: 'file' });

    expect(screen.getByText(/no keychain Komla can use/)).toBeInTheDocument();
  });
});
