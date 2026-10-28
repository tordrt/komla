import { describe, expect, it } from 'vitest';

import {
  buildWorkspaceLayoutHydration,
  hydratePersistedWorkspaceLayout,
  isWorkspaceLayoutPlaceholder,
  keepWorkspaceLayoutView,
} from '../../../src/renderer/lib/workspace-layout-hydration';
import { getAllLeaves } from '../../../src/renderer/lib/layout-utils';

import { createTerminal, createWorkspace } from '../../factories';

import type { LayoutNode, LeafPane } from '../../../src/renderer/types/layout';

describe('buildWorkspaceLayoutHydration', () => {
  it('builds tabs and pane trees from terminal layout hints', () => {
    const workspace = createWorkspace({
      terminals: [
        createTerminal({ id: 'agent' }),
        createTerminal({ id: 'server', layoutHint: 'tab' }),
        createTerminal({ id: 'logs', layoutHint: 'split-right' }),
        createTerminal({ id: 'tests', layoutHint: 'split-bottom' }),
      ],
      primaryTerminalId: 'agent',
    });

    const hydrated = buildWorkspaceLayoutHydration(workspace);

    expect(hydrated?.tabs).toEqual(['agent', 'server']);
    expect(hydrated?.activeTab).toBe('agent');
    expect(getAllLeaves(hydrated!.layouts['agent']).map((leaf) => leaf.terminalId)).toEqual([
      'agent',
    ]);
    expect(getAllLeaves(hydrated!.layouts['server']).map((leaf) => leaf.terminalId)).toEqual([
      'server',
      'logs',
      'tests',
    ]);
  });

  it('activates the tab containing the primary terminal', () => {
    const workspace = createWorkspace({
      terminals: [
        createTerminal({ id: 'server' }),
        createTerminal({ id: 'agent', layoutHint: 'split-right' }),
      ],
      primaryTerminalId: 'agent',
    });

    const hydrated = buildWorkspaceLayoutHydration(workspace);

    expect(hydrated?.tabs).toEqual(['server']);
    expect(hydrated?.activeTab).toBe('server');
    expect(getAllLeaves(hydrated!.layouts['server']).map((leaf) => leaf.terminalId)).toEqual([
      'server',
      'agent',
    ]);
  });

  it('returns null for a workspace without terminals', () => {
    expect(buildWorkspaceLayoutHydration(createWorkspace({ terminals: [] }))).toBeNull();
  });
});

describe('isWorkspaceLayoutPlaceholder', () => {
  it('detects a workspace-id placeholder tab', () => {
    expect(isWorkspaceLayoutPlaceholder('ws-1', ['ws-1'])).toBe(true);
    expect(isWorkspaceLayoutPlaceholder('ws-1', ['term-1'])).toBe(false);
    expect(isWorkspaceLayoutPlaceholder('ws-1', undefined)).toBe(false);
  });
});

describe('hydratePersistedWorkspaceLayout', () => {
  it.each([
    ['server', 'server'],
    ['missing', 'agent'],
    [undefined, 'agent'],
  ])('restores active tab %s with a valid fallback', (activeTab, expected) => {
    const hydrated = hydratePersistedWorkspaceLayout({
      tabs: ['agent', 'server'],
      layouts: {
        agent: { type: 'leaf', id: 'pane-agent', terminalId: 'agent' },
        server: { type: 'leaf', id: 'pane-server', terminalId: 'server' },
      },
      activeTab,
    });

    expect(hydrated?.activeTab).toBe(expected);
  });

  it('defaults to the first tab and first pane without persisted focus state', () => {
    const hydrated = hydratePersistedWorkspaceLayout({
      tabs: ['agent', 'server'],
      layouts: {
        agent: { type: 'leaf', id: 'pane-agent', terminalId: 'agent' },
        server: { type: 'leaf', id: 'pane-server', terminalId: 'server' },
      },
    });

    expect(hydrated).toMatchObject({
      activeTab: 'agent',
      focusedPanes: {
        agent: 'pane-agent',
        server: 'pane-server',
      },
    });
  });
});

describe('keepWorkspaceLayoutView', () => {
  const leaf = (terminalId: string, id = `pane-${terminalId}`): LeafPane => ({
    type: 'leaf',
    id,
    terminalId,
  });
  const split = (first: LayoutNode, second: LayoutNode): LayoutNode => ({
    type: 'split',
    id: `split-${first.id}`,
    direction: 'vertical',
    children: [first, second],
    sizes: [50, 50],
  });

  it('keeps the tab shown and each focused pane where they still are', () => {
    const current = {
      tabs: ['t1', 't2'],
      layouts: { t1: split(leaf('t1'), leaf('t3')), t2: leaf('t2') },
      focusedPanes: { t1: 'pane-t3', t2: 'pane-t2' },
      activeTab: 't2',
    };
    // Arranged on another device, whose panes have ids of their own.
    const arranged = hydratePersistedWorkspaceLayout({
      tabs: ['t2', 't1'],
      layouts: { t2: leaf('t2'), t1: split(leaf('t1', 'other-1'), leaf('t3', 'other-3')) },
    })!;

    const kept = keepWorkspaceLayoutView(arranged, current, new Set(['t1', 't2', 't3']));

    expect(kept.tabs).toEqual(['t2', 't1']);
    expect(kept.activeTab).toBe('t2');
    expect(kept.focusedPanes).toEqual({ t2: 'pane-t2', t1: 'other-3' });
  });

  it('shows the tab the focused pane moved to when the tab shown is gone', () => {
    const current = {
      tabs: ['t1', 't2'],
      layouts: { t1: leaf('t1'), t2: leaf('t2') },
      focusedPanes: { t1: 'pane-t1', t2: 'pane-t2' },
      activeTab: 't2',
    };
    const arranged = hydratePersistedWorkspaceLayout({
      tabs: ['t1'],
      layouts: { t1: split(leaf('t1'), leaf('t2')) },
    })!;

    const kept = keepWorkspaceLayoutView(arranged, current, new Set(['t1', 't2']));

    expect(kept.activeTab).toBe('t1');
    expect(kept.focusedPanes).toEqual({ t1: 'pane-t2' });
  });

  it('keeps panes of open terminals the layout lacks as tabs of their own', () => {
    // `fresh` opened here moments ago, beside t1; `gone` was closed.
    const current = {
      tabs: ['t1', 'gone'],
      layouts: { t1: split(leaf('t1'), leaf('fresh')), gone: leaf('gone') },
      focusedPanes: { t1: 'pane-fresh', gone: 'pane-gone' },
      activeTab: 't1',
    };
    const arranged = hydratePersistedWorkspaceLayout({
      tabs: ['t1'],
      layouts: { t1: leaf('t1') },
    })!;

    const kept = keepWorkspaceLayoutView(arranged, current, new Set(['t1', 'fresh']));

    expect(kept.tabs).toEqual(['t1', 'fresh']);
    expect(kept.layouts).toEqual({ t1: leaf('t1'), fresh: leaf('fresh') });
    expect(kept.focusedPanes).toEqual({ t1: 'pane-t1', fresh: 'pane-fresh' });
    expect(kept.activeTab).toBe('t1');
  });
});
