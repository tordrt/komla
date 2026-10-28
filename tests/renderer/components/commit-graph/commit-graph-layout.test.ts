import { describe, expect, it } from 'vitest';

import { layoutCommitGraph } from '../../../../src/renderer/components/commit-graph/commit-graph-layout';

import type {
  CommitGraphCommit,
  CommitGraphRef,
} from '../../../../src/shared/types/commit-graph';

function commit(hash: string, parentHashes: string[], refs: CommitGraphRef[] = []) {
  return {
    hash,
    parentHashes,
    author: 'A',
    timestamp: 0,
    message: hash,
    refs,
  } satisfies CommitGraphCommit;
}

const branch = (name: string): CommitGraphRef => ({ kind: 'branch', name });
const remote = (name: string): CommitGraphRef => ({ kind: 'remote', name });
const tag = (name: string): CommitGraphRef => ({ kind: 'tag', name });

const ROLES = { currentBranch: 'feature', upstream: 'origin/feature', targetBranch: 'main' };

function lanes(row: { hash: string; color: string }[]) {
  return row.map(({ hash, color }) => `${hash}:${color}`);
}

describe('layoutCommitGraph', () => {
  it('keeps linear history in one lane in the checked-out branch color', () => {
    const rows = layoutCommitGraph(
      [commit('c3', ['c2'], [branch('feature')]), commit('c2', ['c1']), commit('c1', [])],
      ROLES
    );

    expect(rows.map((row) => row.nodeLane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.nodeColor)).toEqual(['ref', 'ref', 'ref']);
    expect(lanes(rows[0].inputLanes)).toEqual([]);
    expect(lanes(rows[1].inputLanes)).toEqual(['c2:ref']);
    expect(lanes(rows[2].outputLanes)).toEqual([]);
  });

  it('opens a lane for a merged branch and joins it back where it forked', () => {
    //  m       merge of b into a
    //  |\
    //  a |
    //  | b
    //  |/
    //  base
    const rows = layoutCommitGraph(
      [
        commit('m', ['a', 'b'], [branch('feature')]),
        commit('a', ['base']),
        commit('b', ['base']),
        commit('base', []),
      ],
      ROLES
    );

    expect(lanes(rows[0].outputLanes)).toEqual(['a:ref', 'b:lane-1']);
    expect(rows[1].nodeLane).toBe(0);
    expect(lanes(rows[1].outputLanes)).toEqual(['base:ref', 'b:lane-1']);
    expect(rows[2].nodeLane).toBe(1);
    expect(rows[2].nodeColor).toBe('lane-1');
    expect(lanes(rows[2].outputLanes)).toEqual(['base:ref', 'base:lane-1']);
    // Both lanes wait for base, which sits in the first.
    expect(rows[3].nodeLane).toBe(0);
    expect(lanes(rows[3].outputLanes)).toEqual([]);
  });

  it('colors the line below the target branch, and a merged-in parent that carries it', () => {
    const rows = layoutCommitGraph(
      [
        commit('m', ['a', 'b'], [branch('feature')]),
        commit('a', ['b']),
        commit('b', ['c'], [remote('origin/main')]),
        commit('c', []),
      ],
      ROLES
    );

    expect(lanes(rows[0].outputLanes)).toEqual(['a:ref', 'b:base-ref']);
    expect(rows[2].nodeColor).toBe('base-ref');
    expect(lanes(rows[2].outputLanes)).toEqual(['c:base-ref']);
  });

  it('puts the colored refs first and drops a remote branch its local branch repeats', () => {
    const [row] = layoutCommitGraph(
      [
        commit(
          'c1',
          [],
          [
            tag('v1.0'),
            branch('other'),
            remote('origin/other'),
            branch('main'),
            remote('origin/feature'),
            branch('feature'),
          ]
        ),
      ],
      ROLES
    );

    expect(row.refs.map((ref) => [ref.name, ref.color])).toEqual([
      ['feature', 'ref'],
      ['main', 'base-ref'],
      ['other', null],
      ['v1.0', null],
    ]);
  });

  it('shows the upstream in its own color while the branch is ahead of it', () => {
    const rows = layoutCommitGraph(
      [commit('c2', ['c1'], [branch('feature')]), commit('c1', [], [remote('origin/feature')])],
      ROLES
    );

    expect(rows[1].refs).toEqual([{ kind: 'remote', name: 'origin/feature', color: 'remote-ref' }]);
    expect(rows[1].nodeColor).toBe('ref');
  });
});
