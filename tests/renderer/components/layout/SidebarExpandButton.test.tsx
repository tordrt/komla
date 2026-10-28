/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (state: { isFullscreen: boolean }) => unknown) =>
    selector({ isFullscreen: false }),
}));

import { SidebarExpandButton } from '../../../../src/renderer/components/layout/SidebarExpandButton';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import {
  setSidebarCollapsed,
  useSidebarMounted,
} from '../../../../src/renderer/lib/sidebar-collapsed';

// Collapsed only counts while a sidebar is mounted.
function SidebarStandIn() {
  useSidebarMounted();
  return null;
}

describe('SidebarExpandButton', () => {
  beforeEach(() => {
    Object.assign(window as any, { api: { platform: 'linux' } });
    setSidebarCollapsed(false);
  });

  it('shows the controls it holds, such as Command center, only while the sidebar is collapsed', () => {
    render(
      <TooltipProvider>
        <SidebarStandIn />
        <SidebarExpandButton>
          <button type="button">Command center</button>
        </SidebarExpandButton>
      </TooltipProvider>
    );
    expect(screen.queryByRole('button', { name: 'Command center' })).toBeNull();

    act(() => setSidebarCollapsed(true));
    expect(screen.getByRole('button', { name: 'Command center' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.queryByRole('button', { name: 'Command center' })).toBeNull();
  });
});
