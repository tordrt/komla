/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pluginCardId } from '../../../../../src/renderer/components/layout/settings/plugin-card';
import { PluginsCard } from '../../../../../src/renderer/components/layout/settings/PluginsCard';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { PluginInfo } from '../../../../../src/shared/types/plugins';

const plugin = (folder: string, state: PluginInfo['state'], id = 'prs'): PluginInfo => ({
  id,
  name: `Pull requests in ${folder}`,
  folder,
  state,
  contributions: [],
});

const renderCard = () =>
  render(
    <TooltipProvider>
      <PluginsCard />
    </TooltipProvider>
  );

describe('PluginsCard', () => {
  beforeEach(() => {
    // The switches measure themselves.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives Settings the row a plugin's page opens it at: the one Komla can read", async () => {
    vi.stubGlobal('api', {
      // A second folder with the same id, which Komla can't read, comes first.
      listPlugins: async () => [
        plugin('prs-copy', 'invalid'),
        plugin('prs', 'on'),
        // Ids alike but for dashes still get rows of their own.
        plugin('prs-', 'on', 'prs-'),
      ],
      onPluginsChange: () => () => {},
    });

    const { container } = renderCard();
    await screen.findByText('Pull requests in prs');

    const rows = container.querySelectorAll(`[id="${pluginCardId('prs')}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Pull requests in prs');
    expect(rows[0]).not.toHaveTextContent('prs-copy');
    expect(container.querySelectorAll(`[id="${pluginCardId('prs-')}"]`)).toHaveLength(1);
  });

  it('shows the commands a plugin would run until it is on, each once', async () => {
    const ci = (state: PluginInfo['state']): PluginInfo => ({
      ...plugin('ci', state, 'ci'),
      contributions: [
        {
          kind: 'status-item',
          id: 'ci.status',
          title: 'CI',
          when: 'Every 120 seconds',
          command: 'gh run list',
        },
        {
          kind: 'sidebar-panel',
          id: 'ci.jobs',
          title: 'Jobs',
          when: 'Every 60 seconds',
          command: 'gh run view',
          // The same command again, as a button's.
          moreCommands: [{ label: 'Refresh', command: 'gh run view' }],
        },
      ],
    });
    let emit: (plugins: PluginInfo[]) => void = () => {};
    vi.stubGlobal('api', {
      listPlugins: async () => [ci('off')],
      onPluginsChange: (listener: typeof emit) => {
        emit = listener;
        return () => {};
      },
    });

    const { container } = renderCard();
    const toggle = await screen.findByRole('button', {
      name: 'The 2 commands it runs',
    });
    const row = container.querySelector('[data-plugin="ci"]') as HTMLElement;
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getAllByText('gh run view')).toHaveLength(1);
    expect(within(row).getByText('gh run list')).toBeInTheDocument();

    // Once it's on, they're a click away.
    await act(async () => emit([ci('on')]));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).queryByText('gh run list')).toBeNull();
  });

  it("deletes a plugin's folder once the user confirms", async () => {
    const deletePlugin = vi.fn(async () => []);
    vi.stubGlobal('api', {
      listPlugins: async () => [plugin('prs', 'on')],
      onPluginsChange: () => () => {},
      deletePlugin,
    });

    renderCard();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete Pull requests in prs',
      })
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('moves to your computer’s trash');
    expect(deletePlugin).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletePlugin).toHaveBeenCalledWith('prs');
    expect(screen.queryByText('Pull requests in prs')).toBeNull();
  });
});
