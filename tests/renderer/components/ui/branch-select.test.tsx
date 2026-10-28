/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BranchSelect } from '../../../../src/renderer/components/ui/branch-select';

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, modal }: React.PropsWithChildren<{ modal?: boolean }>) => (
    <div data-modal={String(modal ?? true)}>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({ config: {}, updateConfig: vi.fn() }),
}));

describe('BranchSelect', () => {
  it('uses a non-modal dropdown so parent dialogs remain open', () => {
    render(
      <BranchSelect value="" onChange={vi.fn()} repoPath="/repo" placeholder="Choose branch" />
    );

    expect(
      screen.getByRole('button', { name: /Choose branch/i }).closest('[data-modal]')
    ).toHaveAttribute('data-modal', 'false');
  });
});
