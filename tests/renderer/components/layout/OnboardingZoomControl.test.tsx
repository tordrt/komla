/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingZoomControl } from '../../../../src/renderer/components/layout/OnboardingZoomControl';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';

const updateConfig = vi.fn();

function renderAt(zoomLevel: number) {
  useConfigStore.setState({ config: { zoomLevel } as never, updateConfig });
  render(
    <TooltipProvider>
      <OnboardingZoomControl />
    </TooltipProvider>
  );
}

describe('OnboardingZoomControl', () => {
  beforeEach(() => {
    updateConfig.mockReset().mockResolvedValue({ ok: true, error: null });
  });

  it('shows the zoom and moves it half a level each way', async () => {
    const user = userEvent.setup();
    renderAt(0);

    expect(screen.getByRole('group', { name: 'Text size' })).toHaveTextContent('100%');
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(updateConfig).toHaveBeenLastCalledWith({ zoomLevel: 0.5 });
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(updateConfig).toHaveBeenLastCalledWith({ zoomLevel: -0.5 });
  });

  it('keeps every step of quick clicks while the first save is still in flight', async () => {
    const user = userEvent.setup();
    const saves: Array<() => void> = [];
    updateConfig.mockImplementation(() => new Promise<void>((resolve) => saves.push(resolve)));
    renderAt(0);

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(updateConfig.mock.calls).toEqual([[{ zoomLevel: 0.5 }], [{ zoomLevel: 1 }]]);
    expect(screen.getByRole('group', { name: 'Text size' })).toHaveTextContent('120%');
    saves.forEach((resolve) => resolve());
  });

  it('disables zooming past the largest and smallest levels', () => {
    renderAt(3);
    expect(screen.getByRole('group', { name: 'Text size' })).toHaveTextContent('173%');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });
});
