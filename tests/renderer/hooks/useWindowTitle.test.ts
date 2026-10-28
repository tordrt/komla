// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWindowTitle } from '../../../src/renderer/hooks/useWindowTitle';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/renderer/types';

const workspace = (id: string, name: string, dynamicTitle?: string) =>
  ({
    id,
    name,
    projectId: 'p1',
    terminals: [{ id: `${id}-term`, status: 'running', dynamicTitle }],
  }) as unknown as Workspace;

describe('useWindowTitle', () => {
  beforeEach(() => {
    document.title = 'Komla';
    useWorkspacesStore.setState({
      workspaces: [workspace('ws-1', 'brave-otter'), workspace('ws-2', 'calm-heron')],
      selectedWorkspaceId: null,
    });
  });

  it('names the open workspace before Komla, and only Komla in Overview', () => {
    renderHook(() => useWindowTitle());
    expect(document.title).toBe('Komla');

    act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-2' }));
    expect(document.title).toBe('calm-heron — Komla');

    act(() => useWorkspacesStore.setState({ selectedWorkspaceId: null }));
    expect(document.title).toBe('Komla');
  });

  it("follows the title the workspace goes by, such as its agent's", () => {
    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' });
    renderHook(() => useWindowTitle());

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('ws-1-term', 'Fix login'));

    expect(document.title).toBe('Fix login — Komla');
  });

  it("leaves out the spinner an agent puts in front of its title, so the title doesn't flicker", () => {
    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' });
    renderHook(() => useWindowTitle());

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('ws-1-term', '⠐ Fix login'));
    expect(document.title).toBe('Fix login — Komla');

    act(() => useWorkspacesStore.getState().setTerminalDynamicTitle('ws-1-term', '✳ Fix login'));
    expect(document.title).toBe('Fix login — Komla');
  });

  // It runs in App, so a re-render here re-renders the whole window.
  it('updates the title without re-rendering', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useWindowTitle();
    });
    const rendersBefore = renders;

    act(() => useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' }));

    expect(document.title).toBe('brave-otter — Komla');
    expect(renders).toBe(rendersBefore);
  });
});
