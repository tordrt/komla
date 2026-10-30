/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiHelpersOffBanner } from '../../../../src/renderer/components/layout/AiHelpersOffBanner';
import { BannerHost } from '../../../../src/renderer/components/layout/BannerHost';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useSettingsDialogStore } from '../../../../src/renderer/stores/settings-dialog.store';

const updateConfig = vi.fn().mockResolvedValue({ ok: true });
const openSettings = vi.fn();
const openExternal = vi.fn();

function setup({
  managedAiHelpers = false,
  utilityProvider = 'komla-managed',
  aiHelpersOffDismissed = false,
}: {
  managedAiHelpers?: boolean;
  utilityProvider?: 'komla-managed' | 'custom';
  aiHelpersOffDismissed?: boolean;
} = {}) {
  window.api = { managedAiHelpers, openExternal } as unknown as typeof window.api;
  useConfigStore.setState({
    config: { utilityProvider, aiHelpersOffDismissed } as never,
    updateConfig,
  });
  render(
    <TooltipProvider>
      <BannerHost>
        <AiHelpersOffBanner />
      </BannerHost>
    </TooltipProvider>
  );
}

const banner = () => screen.queryByText('AI helpers are off in this build.');

describe('AiHelpersOffBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsDialogStore.setState({ openSettings });
  });

  it('shows in a build without the managed AI helpers', () => {
    setup();
    expect(banner()).toBeInTheDocument();
  });

  it('stays hidden in a build with the managed AI helpers', () => {
    setup({ managedAiHelpers: true });
    expect(banner()).toBeNull();
  });

  it('stays hidden once a custom endpoint is chosen', () => {
    setup({ utilityProvider: 'custom' });
    expect(banner()).toBeNull();
  });

  it('stays hidden once dismissed', () => {
    setup({ aiHelpersOffDismissed: true });
    expect(banner()).toBeNull();
  });

  it('stays hidden until the config has loaded', () => {
    window.api = { managedAiHelpers: false } as unknown as typeof window.api;
    useConfigStore.setState({ config: null });
    render(
      <BannerHost>
        <AiHelpersOffBanner />
      </BannerHost>
    );
    expect(banner()).toBeNull();
  });

  it('remembers the dismissal', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss AI helpers notice' }));
    expect(updateConfig).toHaveBeenCalledWith({ aiHelpersOffDismissed: true });
  });

  it('opens the AI utilities settings to choose an endpoint', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Choose endpoint' }));
    expect(openSettings).toHaveBeenCalledWith({ tab: 'general', card: 'AI utilities' });
  });

  it('links to the public download for the managed helpers', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Download Komla' }));
    expect(openExternal).toHaveBeenCalledWith('https://komla.dev/download');
  });
});
