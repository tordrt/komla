/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pluginCardId } from '../../../../../src/renderer/components/layout/settings/plugin-card';
import { PluginsCard } from '../../../../../src/renderer/components/layout/settings/PluginsCard';

import type { PluginInfo } from '../../../../../src/shared/types/plugins';

const plugin = (folder: string, state: PluginInfo['state'], id = 'prs'): PluginInfo => ({
  id,
  name: `Pull requests in ${folder}`,
  folder,
  state,
  contributions: [],
});

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

    const { container } = render(<PluginsCard />);
    await screen.findByText('Pull requests in prs');

    const rows = container.querySelectorAll(`[id="${pluginCardId('prs')}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Pull requests in prs');
    expect(rows[0]).not.toHaveTextContent('prs-copy');
    expect(container.querySelectorAll(`[id="${pluginCardId('prs-')}"]`)).toHaveLength(1);
  });
});
