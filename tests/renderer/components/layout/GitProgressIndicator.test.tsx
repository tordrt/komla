/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitOperationDetails,
  GitProgressIndicator,
} from '../../../../src/renderer/components/layout/GitProgressIndicator';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useGitProgressStore } from '../../../../src/renderer/stores/git-progress.store';

const workspaceState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  workspaces: [
    { id: 'ws-1', workingDirectory: '/repo' },
    { id: 'ws-2', workingDirectory: '/other-repo' },
  ],
};

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: typeof workspaceState) => unknown) =>
    selector(workspaceState),
}));

function renderIndicator() {
  return render(<GitProgressIndicator />, { wrapper: TooltipProvider });
}

describe('GitProgressIndicator', () => {
  beforeEach(() => {
    vi.useRealTimers();
    workspaceState.selectedWorkspaceId = 'ws-1';
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
  });

  it("names the operation rather than Git's longer stage", () => {
    useGitProgressStore.getState().startOperation('push-1', 'push', '/repo');
    useGitProgressStore.getState().updateProgress('/repo', 0, 'Syncing local Git state');

    renderIndicator();

    expect(screen.getByRole('status', { name: 'Pushing' })).toHaveTextContent('Pushing');
    expect(screen.queryByText('Syncing local Git state')).not.toBeInTheDocument();
  });

  it('capitalizes only the first word of a hyphenated operation', () => {
    useGitProgressStore.getState().startOperation('ff-1', 'fast-forward', '/repo');

    renderIndicator();

    expect(screen.getByText('Fast-forwarding')).toBeInTheDocument();
  });

  it('ignores operations running in other workspaces', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useGitProgressStore.getState().startOperation('fetch-1', 'fetch', '/repo');
    vi.setSystemTime(2_000);
    useGitProgressStore.getState().startOperation('push-2', 'push', '/other-repo');
    vi.useRealTimers();

    renderIndicator();

    expect(screen.getByText('Fetching')).toBeInTheDocument();
    expect(screen.queryByText('Pushing')).not.toBeInTheDocument();
  });

  it('renders nothing when only another workspace has an operation', () => {
    useGitProgressStore.getState().startOperation('push-2', 'push', '/other-repo');

    const { container } = renderIndicator();

    expect(container).toBeEmptyDOMElement();
  });
});

describe('GitOperationDetails', () => {
  it("adds Git's stage and its percentage to the operation", () => {
    render(
      <GitOperationDetails
        operation={{
          id: 'fetch-1',
          operation: 'fetch',
          repoPath: '/repo',
          percent: 45,
          stage: 'Receiving objects',
          startedAt: 1,
        }}
      />
    );

    expect(screen.getByText('Fetching…')).toBeInTheDocument();
    expect(screen.getByText('Receiving objects')).toHaveTextContent('Receiving objects 45%');
  });

  it('shows only the operation before Git reports a stage', () => {
    const { container } = render(
      <GitOperationDetails
        operation={{
          id: 'push-1',
          operation: 'push',
          repoPath: '/repo',
          percent: 0,
          stage: '',
          startedAt: 1,
        }}
      />
    );

    expect(container).toHaveTextContent(/^Pushing…$/);
  });
});
