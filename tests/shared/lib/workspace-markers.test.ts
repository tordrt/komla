import { describe, expect, it } from 'vitest';

import {
  MAX_WORKSPACE_MARKERS,
  normalizePersistedWorkspaceMarkers,
  sameWorkspaceMarkers,
  savedWorkspaceMarkers,
  shownWorkspaceMarkers,
  withoutWorkspaceMarker,
  withWorkspaceMarker,
  workspaceCardTagAppearance,
  type WorkspaceMarker,
} from '../../../src/shared/lib/workspace-markers';

const pr: WorkspaceMarker = { key: 'pr', label: 'PR #12', tone: 'info' };
const ci: WorkspaceMarker = { key: 'ci', label: 'CI running', tone: 'info', spinner: true };

describe('withWorkspaceMarker', () => {
  it("replaces the marker of its key in its place, and else adds it after the rest", () => {
    const deploy: WorkspaceMarker = { key: 'deploy', label: 'Staging', tone: 'neutral' };
    const approved: WorkspaceMarker = { ...pr, label: 'PR #12 approved' };
    expect(withWorkspaceMarker(undefined, pr)).toEqual([pr]);
    expect(withWorkspaceMarker([pr, deploy], approved)).toEqual([approved, deploy]);
    expect(withoutWorkspaceMarker([pr, deploy], 'pr')).toEqual([deploy]);
    // No markers is none at all, so a workspace without any saves nothing.
    expect(withoutWorkspaceMarker([pr], 'pr')).toBeUndefined();
  });
});

describe('savedWorkspaceMarkers', () => {
  it('leaves out work under way, which ends with Komla', () => {
    expect(savedWorkspaceMarkers([ci, pr])).toEqual([pr]);
    expect(savedWorkspaceMarkers([ci])).toBeUndefined();
  });
});

describe('shownWorkspaceMarkers', () => {
  it('shows work under way first', () => {
    expect(shownWorkspaceMarkers([pr, ci])).toEqual([ci, pr]);
    expect(shownWorkspaceMarkers(undefined)).toEqual([]);
  });
});

describe('sameWorkspaceMarkers', () => {
  it('compares each marker, in order', () => {
    expect(sameWorkspaceMarkers(undefined, [])).toBe(true);
    expect(sameWorkspaceMarkers([pr, ci], [{ ...pr }, { ...ci }])).toBe(true);
    expect(sameWorkspaceMarkers([pr, ci], [ci, pr])).toBe(false);
    expect(sameWorkspaceMarkers([pr], [{ ...pr, tooltip: 'why' }])).toBe(false);
  });
});

describe('normalizePersistedWorkspaceMarkers', () => {
  it('scrubs a hand-edited file: bad keys and labels, repeats, spinners and too many', () => {
    expect(
      normalizePersistedWorkspaceMarkers([
        { key: 'pr', label: '  PR   #12 ', tone: 'purple', tooltip: 'x'.repeat(600), spinner: true },
        { key: 'pr', label: 'Again' },
        { key: 'has space', label: 'Bad key' },
        { key: 'progress', label: 'CI running', spinner: true },
        { key: 'empty', label: '   ' },
        null,
        ...Array.from({ length: MAX_WORKSPACE_MARKERS }, (_, i) => ({ key: `m${i}`, label: 'M' })),
      ])
    ).toEqual([
      { key: 'pr', label: 'PR #12', tone: 'neutral', tooltip: 'x'.repeat(500) },
      ...Array.from({ length: MAX_WORKSPACE_MARKERS - 1 }, (_, i) => ({
        key: `m${i}`,
        label: 'M',
        tone: 'neutral',
      })),
    ]);
    expect(normalizePersistedWorkspaceMarkers('pr')).toBeUndefined();
    expect(normalizePersistedWorkspaceMarkers([])).toBeUndefined();
  });
});

describe('workspaceCardTagAppearance', () => {
  it("shows progress, spinning, in the tag's place, and else the tag", () => {
    const tags = [{ name: 'Blocked', tone: 'error' as const }];
    expect(workspaceCardTagAppearance(tags, { tag: 'blocked', markers: [pr, ci] })).toEqual({
      name: 'CI running',
      tone: 'info',
      spinner: true,
    });
    // A device without markers sees the tag, as their place is beside it.
    expect(workspaceCardTagAppearance(tags, { tag: 'blocked', markers: [pr] })).toEqual({
      name: 'Blocked',
      tone: 'error',
    });
    expect(workspaceCardTagAppearance(tags, {})).toBeUndefined();
  });
});
