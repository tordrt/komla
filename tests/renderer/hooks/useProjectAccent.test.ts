// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectAccent } from '../../../src/renderer/hooks/useProjectAccent';
import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Project, Workspace } from '../../../src/renderer/types';

const projects = [
  { id: 'p1', name: 'one', color: 'hsl(200, 75%, 50%)' },
  { id: 'p2', name: 'two', color: 'hsl(340, 70%, 55%)' },
] as Project[];
const workspace = (id: string, projectId?: string) => ({ id, projectId }) as Workspace;
const workspaces = [
  workspace('one-a', 'p1'),
  workspace('one-b', 'p1'),
  workspace('two-a', 'p2'),
  workspace('no-project'),
];

function select(id: string | null, list: Workspace[] = workspaces) {
  act(() => useWorkspacesStore.setState({ selectedWorkspaceId: id, workspaces: list }));
}

function renderAccent(selectedWorkspaceId: string | null) {
  const sidebar = document.createElement('div');
  const main = document.createElement('main');
  select(selectedWorkspaceId);
  renderHook(() => useProjectAccent(sidebar, main));
  // The variables are inherited, so every write restyles everything below these elements.
  const writes = [sidebar, main].flatMap((el) => [
    vi.spyOn(el.style, 'setProperty'),
    vi.spyOn(el.style, 'removeProperty'),
  ]);
  const removals = writes.filter((_, index) => index % 2 === 1);
  const primary = () => [sidebar, main].map((el) => el.style.getPropertyValue('--primary'));
  return { writes, removals, primary };
}

describe('useProjectAccent', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects });
  });

  it("colors the sidebar and main area with the selected workspace's project", () => {
    const { primary } = renderAccent('one-a');

    const [sidebarPrimary, mainPrimary] = primary();
    expect(sidebarPrimary).not.toBe('');
    expect(mainPrimary).toBe(sidebarPrimary);
  });

  it('colors the sidebar and main area when they mount after the color is known', () => {
    // App shows its loading screen until config loads, while a workspace may already be selected.
    select('one-a');
    const { rerender } = renderHook(
      ({ sidebar, main }: { sidebar: HTMLElement | null; main: HTMLElement | null }) =>
        useProjectAccent(sidebar, main),
      { initialProps: { sidebar: null, main: null } }
    );

    const sidebar = document.createElement('div');
    const main = document.createElement('main');
    rerender({ sidebar, main });

    expect(sidebar.style.getPropertyValue('--primary')).not.toBe('');
    expect(main.style.getPropertyValue('--primary')).not.toBe('');
  });

  it('leaves the colors untouched when switching within a project', () => {
    const { writes } = renderAccent('one-a');

    select('one-b');

    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it('leaves the colors untouched when another workspace changes', () => {
    const { writes } = renderAccent('one-a');

    select(
      'one-a',
      workspaces.map((w) => ({ ...w }))
    );

    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("replaces the colors in place with another project's", () => {
    const { removals, primary } = renderAccent('one-a');
    const [before] = primary();

    select('two-a');

    for (const removal of removals) expect(removal).not.toHaveBeenCalled();
    const [sidebarPrimary, mainPrimary] = primary();
    expect(sidebarPrimary).not.toBe(before);
    expect(sidebarPrimary).not.toBe('');
    expect(mainPrimary).toBe(sidebarPrimary);
  });

  it('clears the colors for a workspace without a project, and with nothing selected', () => {
    const { primary } = renderAccent('one-a');

    select('no-project');
    expect(primary()).toEqual(['', '']);

    select('one-a');
    select(null);
    expect(primary()).toEqual(['', '']);
  });
});
