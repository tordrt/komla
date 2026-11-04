/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppMenu } from '../../../../src/renderer/components/layout/AppMenu';
import { KOMLA_GITHUB_URL } from '../../../../src/shared/constants/komla-github';

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: { config: null }) => unknown) => selector({ config: null }),
}));

vi.mock('../../../../src/renderer/components/layout/GettingStartedMenu', () => ({
  GettingStartedMenu: () => null,
}));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DropdownMenuSeparator: () => <div />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('AppMenu', () => {
  const openExternal = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    openExternal.mockClear();
    Object.assign(window as object, { api: { openExternal } });
  });

  function renderMenu() {
    render(
      <AppMenu
        onOpenSettings={vi.fn()}
        onOpenShortcuts={vi.fn()}
        onOpenFeedback={vi.fn()}
        onOpenSettingsTab={vi.fn()}
        onOpenNewWorkspace={vi.fn()}
      />
    );
  }

  it('opens the GitHub repository', () => {
    renderMenu();

    fireEvent.click(screen.getByText('Star on GitHub'));

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(KOMLA_GITHUB_URL);
  });
});
