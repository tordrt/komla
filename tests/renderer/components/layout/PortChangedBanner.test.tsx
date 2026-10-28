/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PortChangedBanner } from '../../../../src/renderer/components/layout/PortChangedBanner';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

function mockApi(): void {
  window.api = {
    getPortChange: vi.fn().mockResolvedValue({ oldPort: 52863, newPort: 52864 }),
    onPortChanged: vi.fn(() => vi.fn()),
  } as unknown as typeof window.api;
}

describe('PortChangedBanner', () => {
  beforeEach(() => {
    mockApi();
  });

  it('explains what changed and what to do', async () => {
    const onOpenSettings = vi.fn();
    render(<PortChangedBanner onOpenSettings={onOpenSettings} />, { wrapper: TooltipProvider });

    expect(
      await screen.findByText(
        "Komla's MCP port changed from 52863 to 52864 because 52863 was in use."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Agents set up with the old port can't reach Komla until you update their MCP config."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/stole our port/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update MCP config' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('uses a readable warning icon and labels the dismiss button', async () => {
    const { container } = render(<PortChangedBanner onOpenSettings={vi.fn()} />, {
      wrapper: TooltipProvider,
    });
    await screen.findByRole('button', { name: 'Update MCP config' });

    expect(container.querySelector('svg')?.parentElement).toHaveClass('text-warning');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss port change notice' }));
    expect(screen.queryByRole('button', { name: 'Update MCP config' })).toBeNull();
  });
});
