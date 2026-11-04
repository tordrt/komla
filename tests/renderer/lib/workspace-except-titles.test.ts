import { describe, expect, it } from 'vitest';

import {
  sameWorkspaceExceptTitles,
  sameWorkspacesExceptTitles,
} from '../../../src/renderer/lib/workspace-except-titles';

import type { Workspace } from '../../../src/renderer/types';

function workspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'w1',
    name: 'feature',
    status: 'active',
    terminals: [
      { id: 't1', name: 'Agent', status: 'running', dynamicTitle: '⠋ Fixing tests' },
      { id: 't2', name: 'Terminal', status: 'running' },
    ],
    lastDynamicTitle: '⠋ Fixing tests',
    ...overrides,
  } as unknown as Workspace;
}

describe('sameWorkspaceExceptTitles', () => {
  it('ignores a change to a terminal title and the workspace title it sets', () => {
    const before = workspace();
    const after = {
      ...before,
      lastDynamicTitle: '⠙ Fixing tests',
      terminals: [{ ...before.terminals[0], dynamicTitle: '⠙ Fixing tests' }, before.terminals[1]],
    };
    expect(sameWorkspaceExceptTitles(before, after)).toBe(true);
  });

  it('ignores a title appearing for the first time', () => {
    const before = workspace({ lastDynamicTitle: undefined });
    delete (before as Partial<Workspace>).lastDynamicTitle;
    const after = { ...before, lastDynamicTitle: 'zsh' };
    expect(sameWorkspaceExceptTitles(before, after)).toBe(true);
  });

  it('notices any other change', () => {
    const before = workspace();
    expect(sameWorkspaceExceptTitles(before, { ...before, name: 'renamed' })).toBe(false);
    expect(
      sameWorkspaceExceptTitles(before, {
        ...before,
        terminals: [{ ...before.terminals[0], status: 'stopped' }, before.terminals[1]],
      })
    ).toBe(false);
    expect(sameWorkspaceExceptTitles(before, { ...before, terminals: [before.terminals[0]] })).toBe(
      false
    );
    expect(sameWorkspaceExceptTitles(before, { ...before, customName: 'Mine' })).toBe(false);
    expect(sameWorkspaceExceptTitles(before, undefined)).toBe(false);
    expect(sameWorkspaceExceptTitles(undefined, undefined)).toBe(true);
  });

  it('treats a missing field as one set to undefined', () => {
    const before = workspace();
    expect(sameWorkspaceExceptTitles(before, { ...before, customName: undefined })).toBe(true);
    expect(sameWorkspaceExceptTitles({ ...before, customName: undefined }, before)).toBe(true);
  });
});

describe('sameWorkspacesExceptTitles', () => {
  it('compares each workspace in order', () => {
    const a = workspace();
    const b = workspace({ id: 'w2' });
    const retitled = { ...a, lastDynamicTitle: 'other' };
    expect(sameWorkspacesExceptTitles([a, b], [retitled, b])).toBe(true);
    expect(sameWorkspacesExceptTitles([a, b], [b, a])).toBe(false);
    expect(sameWorkspacesExceptTitles([a, b], [a])).toBe(false);
  });
});
