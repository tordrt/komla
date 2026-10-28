import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteWorkspaceTag,
  pullRequestTaggingDescription,
  tagWorkspaces,
  updateWorkspaceTag,
} from '../../../src/renderer/lib/workspace-tags';
import { normalizeWorkspaceTags } from '../../../src/shared/lib/workspace-tags';
import { createWorkspace } from '../../factories';

import type { WorkspaceTagDefinition } from '../../../src/shared/lib/workspace-tags';
import type { Workspace } from '../../../src/shared/types';

const configState = {
  config: { workspaceTags: [] as WorkspaceTagDefinition[] },
  updateConfig: vi.fn(async (_updates: object) => ({ ok: true, error: null })),
  loadConfig: vi.fn(),
};
vi.mock('../../../src/renderer/stores/config.store', () => ({
  useConfigStore: {
    getState: () => configState,
    setState: (partial: Partial<typeof configState>) => Object.assign(configState, partial),
  },
}));

const workspacesState = {
  workspaces: [] as Workspace[],
  setTag: vi.fn(),
  moveHiddenWorkspaceTag: vi.fn(),
};
vi.mock('../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: { getState: () => workspacesState },
}));

vi.mock('../../../src/renderer/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

const review: WorkspaceTagDefinition = {
  name: 'Waiting for review',
  tone: 'info',
};
const blocked: WorkspaceTagDefinition = { name: 'Blocked', tone: 'warning' };

beforeEach(() => {
  vi.clearAllMocks();
  configState.config.workspaceTags = [review, blocked];
  workspacesState.workspaces = [
    createWorkspace({ id: 'ws-1', tag: 'Waiting for review' }),
    createWorkspace({ id: 'ws-4', tag: 'Waiting for review', tagSource: 'pull-request' }),
    createWorkspace({ id: 'ws-2', tag: 'Blocked' }),
    createWorkspace({ id: 'ws-3' }),
  ];
});

describe('tagWorkspaces', () => {
  it('uses the tag of the same name, whatever case was typed', () => {
    tagWorkspaces(['ws-3'], ' waiting FOR review ');

    expect(workspacesState.setTag).toHaveBeenCalledWith(['ws-3'], 'Waiting for review');
    expect(configState.updateConfig).not.toHaveBeenCalled();
  });

  it('adds a new tag to the list with its settings', () => {
    tagWorkspaces(['ws-3'], 'Waiting for QA', { tone: 'attention' });

    expect(configState.updateConfig).toHaveBeenCalledWith({
      workspaceTags: [review, blocked, { name: 'Waiting for QA', tone: 'attention' }],
    });
    expect(workspacesState.setTag).toHaveBeenCalledWith(['ws-3'], 'Waiting for QA');
  });
});

describe('tagWorkspaces at the limit', () => {
  it('adds no new tag to a full list, and puts none on', () => {
    configState.config.workspaceTags = Array.from({ length: 50 }, (_, i) => ({
      name: `Tag ${i}`,
      tone: 'neutral' as const,
    }));

    tagWorkspaces(['ws-3'], 'One more');

    expect(configState.updateConfig).not.toHaveBeenCalled();
    expect(workspacesState.setTag).not.toHaveBeenCalled();
  });
});

describe('updateWorkspaceTag', () => {
  it('carries a new name over to the workspaces that have the tag', () => {
    expect(updateWorkspaceTag('Waiting for review', { name: 'In review' })).toEqual({});

    expect(configState.updateConfig).toHaveBeenCalledWith({
      workspaceTags: [{ ...review, name: 'In review' }, blocked],
    });
    // A tag from a pull request stays one, so the pull request still moves it on.
    expect(workspacesState.setTag).toHaveBeenCalledWith(['ws-1'], 'In review', undefined);
    expect(workspacesState.setTag).toHaveBeenCalledWith(['ws-4'], 'In review', 'pull-request');
    expect(workspacesState.moveHiddenWorkspaceTag).toHaveBeenCalledWith(
      'Waiting for review',
      'In review'
    );
  });

  it('builds a change on the one before it, before that one is saved', () => {
    updateWorkspaceTag('Waiting for review', { name: 'In review' });
    updateWorkspaceTag('In review', { tone: 'success' });

    expect(configState.updateConfig).toHaveBeenLastCalledWith({
      workspaceTags: [{ ...review, name: 'In review', tone: 'success' }, blocked],
    });
  });

  it('refuses a name another tag has', () => {
    expect(updateWorkspaceTag('Waiting for review', { name: 'blocked' }).error).toBe(
      "There's a Blocked tag already."
    );
    expect(configState.updateConfig).not.toHaveBeenCalled();
  });
});

describe('deleteWorkspaceTag', () => {
  it('takes the tag out of the list and off its workspaces', () => {
    deleteWorkspaceTag('blocked');

    expect(configState.updateConfig).toHaveBeenCalledWith({ workspaceTags: [review] });
    expect(workspacesState.setTag).toHaveBeenCalledWith(['ws-2'], undefined, undefined);
    expect(workspacesState.moveHiddenWorkspaceTag).toHaveBeenCalledWith('Blocked', undefined);
  });
});

describe('pullRequestTaggingDescription', () => {
  it('names the tags it adds, and says when there are none to add', () => {
    const tags = normalizeWorkspaceTags(undefined).map((tag) =>
      tag.pullRequestState === 'in-review' ? { ...tag, name: 'Waiting for review' } : tag
    );
    expect(pullRequestTaggingDescription(tags)).toMatch(
      /^Tags a workspace Waiting for review while its GitHub pull request waits for review, and Needs changes when a reviewer requests changes,/
    );
    expect(
      pullRequestTaggingDescription(tags.filter((tag) => tag.name !== 'Needs changes'))
    ).toMatch(/^Tags a workspace Waiting for review while .* waits for review, and takes/);
    expect(pullRequestTaggingDescription([])).toBe(
      'The tags it would add were deleted, so it adds none.'
    );
  });
});
