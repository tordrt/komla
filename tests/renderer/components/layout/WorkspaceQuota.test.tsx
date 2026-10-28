/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const licenseState = {
  quota: { count: 4, limit: 4, isLicensed: false } as {
    count: number;
    limit: number;
    isLicensed: boolean;
  },
};
vi.mock('../../../../src/renderer/stores/license.store', () => ({
  useLicenseStore: (selector: (state: typeof licenseState) => unknown) => selector(licenseState),
}));

type WorkspaceStub = { status: string; backend?: { kind: string } };
const workspacesState = { workspaces: [] as WorkspaceStub[] };
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof workspacesState) => unknown) =>
    selector(workspacesState),
}));

import { WorkspaceQuota } from '../../../../src/renderer/components/layout/WorkspaceQuota';

describe('WorkspaceQuota', () => {
  beforeEach(() => {
    licenseState.quota = { count: 4, limit: 4, isLicensed: false };
    workspacesState.workspaces = [{ status: 'active', backend: { kind: 'ssh' } }];
  });

  it('hides while there are no active workspaces', () => {
    licenseState.quota = { count: 0, limit: 4, isLicensed: false };
    workspacesState.workspaces = [{ status: 'trashed', backend: { kind: 'ssh' } }];
    const { container } = render(<WorkspaceQuota onUpgradeClick={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('hides with only local workspaces, which are unlimited', () => {
    licenseState.quota = { count: 0, limit: 4, isLicensed: false };
    workspacesState.workspaces = [{ status: 'active' }, { status: 'active' }];
    const { container } = render(<WorkspaceQuota onUpgradeClick={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('uses a warning color rather than an error color at the limit', () => {
    const { container } = render(<WorkspaceQuota onUpgradeClick={vi.fn()} />);

    const button = screen.getByRole('button', { name: /SSH workspaces/ });
    expect(button).toHaveClass('text-warning');
    expect(button).not.toHaveClass('text-destructive');
    expect(container.querySelector('.bg-warning')).not.toBeNull();
    expect(container.querySelector('.bg-destructive')).toBeNull();
  });

  it('stays neutral below the limit', () => {
    licenseState.quota = { count: 2, limit: 4, isLicensed: false };
    render(<WorkspaceQuota onUpgradeClick={vi.fn()} />);

    expect(screen.getByRole('button', { name: /SSH workspaces/ })).toHaveClass(
      'text-muted-foreground'
    );
  });
});
