import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HIDDEN_WORKSPACE_TAGS,
  DEFAULT_WORKSPACE_TAGS,
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAGS,
  normalizeWorkspaceTagName,
  normalizeWorkspaceTags,
  pullRequestTagState,
  pullRequestTagUpdate,
  withWorkspaceTag,
  workspaceTagKey,
} from '../../../src/shared/lib/workspace-tags';

import type { PullRequestSummary } from '../../../src/shared/types/pull-request';

describe('normalizeWorkspaceTags', () => {
  it('offers the default tags until a list is saved, even an empty one', () => {
    expect(normalizeWorkspaceTags(undefined)).toEqual(DEFAULT_WORKSPACE_TAGS);
    expect(normalizeWorkspaceTags([])).toEqual([]);
  });

  it('starts with On hold among the defaults, hidden in the sidebar', () => {
    expect(DEFAULT_WORKSPACE_TAGS.map((tag) => tag.name)).toContain('On hold');
    expect(DEFAULT_HIDDEN_WORKSPACE_TAGS).toEqual([workspaceTagKey('On hold')]);
  });

  it('keeps one tag per pull request state, the first, and drops unknown states', () => {
    expect(
      normalizeWorkspaceTags([
        { name: 'Review', pullRequestState: 'in-review' },
        { name: 'Also review', pullRequestState: 'in-review' },
        { name: 'Odd', pullRequestState: 'closed' },
      ]).map((tag) => tag.pullRequestState)
    ).toEqual(['in-review', undefined, undefined]);
  });

  it('scrubs a hand-edited list: bad entries, unknown colors and repeats in other cases', () => {
    expect(
      normalizeWorkspaceTags([
        { name: '  Waiting   for QA ', tone: 'purple' },
        { name: 'waiting for qa', tone: 'error' },
        { name: '' },
        'Blocked',
        null,
        { name: 'On hold', tone: 'warning' },
      ])
    ).toEqual([
      { name: 'Waiting for QA', tone: 'neutral' },
      { name: 'On hold', tone: 'warning' },
    ]);
  });
});

describe('normalizeWorkspaceTags looks', () => {
  it('keeps a spinner and an image data URL icon, and drops anything else', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    expect(
      normalizeWorkspaceTags([
        { name: 'CI running', tone: 'info', spinner: true, icon },
        { name: 'Odd', spinner: 'yes', icon: 'javascript:alert(1)' },
        { name: 'Huge', icon: `data:image/png;base64,${'A'.repeat(64 * 1024)}` },
      ])
    ).toEqual([
      { name: 'CI running', tone: 'info', icon, spinner: true },
      { name: 'Odd', tone: 'neutral' },
      { name: 'Huge', tone: 'neutral' },
    ]);
  });
});

describe('normalizeWorkspaceTagName', () => {
  it('keeps a tag on one line and short enough for the pill', () => {
    expect(normalizeWorkspaceTagName(' Waiting\nfor  review ')).toBe('Waiting for review');
    expect(normalizeWorkspaceTagName('x'.repeat(100))).toHaveLength(MAX_WORKSPACE_TAG_LENGTH);
  });
});

describe('withWorkspaceTag', () => {
  it('adds a new tag with the new-tag defaults, and leaves the list alone for one it has', () => {
    const tags = normalizeWorkspaceTags(undefined);
    expect(withWorkspaceTag(tags, 'BLOCKED')).toBe(tags);
    expect(withWorkspaceTag(tags, 'Waiting for QA', { tone: 'info' }).at(-1)).toEqual({
      name: 'Waiting for QA',
      tone: 'info',
    });
  });
});

describe('withWorkspaceTag at the limit', () => {
  it('leaves a full list as it is rather than drop a tag', () => {
    const full = Array.from({ length: MAX_WORKSPACE_TAGS }, (_, i) => ({
      name: `Tag ${i}`,
      tone: 'neutral' as const,
    }));
    expect(withWorkspaceTag(full, 'One more')).toBe(full);
  });
});

describe('pullRequestTagState', () => {
  const pr = (overrides: Partial<PullRequestSummary>): PullRequestSummary => ({
    number: 1,
    title: 'Fix login',
    url: 'https://github.com/acme/app/pull/1',
    state: 'open',
    ci: 'passed',
    checks: [],
    ...overrides,
  });

  it('places open pull requests waiting on a review or changes, and nothing else', () => {
    expect(pullRequestTagState(pr({}))).toBe('in-review');
    expect(pullRequestTagState(pr({ review: 'required' }))).toBe('in-review');
    expect(pullRequestTagState(pr({ review: 'changes-requested' }))).toBe('needs-changes');
    expect(pullRequestTagState(pr({ review: 'approved' }))).toBeUndefined();
    expect(pullRequestTagState(pr({ state: 'merged', review: 'approved' }))).toBeUndefined();
    expect(pullRequestTagState(pr({ state: 'draft' }))).toBeUndefined();
    expect(pullRequestTagState(pr({ state: 'closed' }))).toBeUndefined();
    expect(pullRequestTagState(undefined)).toBeUndefined();
  });
});

describe('pullRequestTagUpdate', () => {
  const tags = normalizeWorkspaceTags(undefined);

  it('tags an untagged workspace, and moves its tag on with the pull request', () => {
    expect(pullRequestTagUpdate({}, 'in-review', tags)).toEqual({
      pullRequestState: 'in-review',
      tag: 'In review',
      tagSource: 'pull-request',
    });
    expect(
      pullRequestTagUpdate(
        { tag: 'In review', tagSource: 'pull-request', pullRequestState: 'in-review' },
        undefined,
        tags
      )
    ).toEqual({ pullRequestState: undefined, tag: undefined, tagSource: undefined });
  });

  it('puts on the tag for that state whatever the user renamed it, and none once deleted', () => {
    const renamed = tags.map((tag) =>
      tag.pullRequestState === 'in-review' ? { ...tag, name: 'Waiting for review' } : tag
    );
    expect(pullRequestTagUpdate({}, 'in-review', renamed)?.tag).toBe('Waiting for review');
    expect(
      pullRequestTagUpdate(
        {},
        'needs-changes',
        tags.filter((tag) => tag.name !== 'Needs changes')
      )
    ).toEqual({ pullRequestState: 'needs-changes', tag: undefined, tagSource: undefined });
  });

  it("keeps a tag taken off while the pull request stands still, even renamed, and the user's own", () => {
    const renamed = tags.map((tag) =>
      tag.pullRequestState === 'needs-changes' ? { ...tag, name: 'Fix it' } : tag
    );
    expect(
      pullRequestTagUpdate({ pullRequestState: 'needs-changes' }, 'needs-changes', renamed)
    ).toBeUndefined();
    expect(pullRequestTagUpdate({ tag: 'Blocked' }, 'in-review', tags)).toEqual({
      pullRequestState: 'in-review',
    });
  });
});
