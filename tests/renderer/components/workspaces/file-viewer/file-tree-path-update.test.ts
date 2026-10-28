/**
 * @vitest-environment jsdom
 */
import { FileTree } from '@pierre/trees';
import { afterEach, describe, expect, it } from 'vitest';

import { planFileTreePathUpdate } from '../../../../../src/renderer/components/workspaces/file-viewer/file-tree-path-update';

const trees: FileTree[] = [];

function makeTree(
  paths: readonly string[],
  initialExpansion: 'open' | 'closed' = 'open'
): FileTree {
  const tree = new FileTree({ paths, flattenEmptyDirectories: true, initialExpansion });
  trees.push(tree);
  return tree;
}

function visiblePaths(tree: FileTree): string[] {
  return tree.getVisibleRows(0, tree.getVisibleCount() - 1).map((row) => row.path);
}

function hasPathIn(tree: FileTree) {
  return (path: string) => tree.getItem(path) != null;
}

/** Applies the planned update and checks the tree now matches one built from nextPaths. */
function expectUpdateMatchesRebuild(prevPaths: string[], nextPaths: string[]): FileTree {
  const tree = makeTree(prevPaths);
  const operations = planFileTreePathUpdate(prevPaths, nextPaths, hasPathIn(tree));

  expect(operations).not.toBeNull();
  tree.batch(operations!);
  expect(visiblePaths(tree)).toEqual(visiblePaths(makeTree(nextPaths)));
  return tree;
}

afterEach(() => {
  for (const tree of trees.splice(0)) tree.cleanUp();
});

describe('planFileTreePathUpdate', () => {
  it('plans nothing when a re-list returns the same paths', () => {
    const tree = makeTree(['src/a.ts', 'src/b.ts']);

    expect(
      planFileTreePathUpdate(['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/a.ts'], hasPathIn(tree))
    ).toEqual([]);
  });

  it('adds created files and removes deleted ones', () => {
    expectUpdateMatchesRebuild(
      ['src/a.ts', 'src/b.ts', 'README.md'],
      ['src/a.ts', 'src/new/c.ts', 'README.md', 'docs/guide.md']
    );
  });

  it('removes folders that their last file left, up to the topmost emptied one', () => {
    expectUpdateMatchesRebuild(
      ['src/deep/er/a.ts', 'src/b.ts', 'lib/x.ts'],
      ['src/b.ts', 'lib/x.ts']
    );
    expectUpdateMatchesRebuild(['src/deep/er/a.ts', 'lib/x.ts'], ['lib/x.ts']);
  });

  it('keeps a folder open when its files are renamed, instead of recreating it', () => {
    const tree = makeTree(['src/a.ts', 'lib/x.ts'], 'closed');
    tree.getItem('src')?.expand();

    tree.batch(
      planFileTreePathUpdate(['src/a.ts', 'lib/x.ts'], ['src/b.ts', 'lib/x.ts'], hasPathIn(tree))!
    );

    expect(tree.getItem('src')?.isExpanded()).toBe(true);
    expect(visiblePaths(tree)).toEqual(['lib/', 'src/', 'src/b.ts']);
  });

  it('keeps an explicit empty folder once a file lands in it, and drops one that disappears', () => {
    expectUpdateMatchesRebuild(['notes/', 'a.ts'], ['notes/todo.md', 'a.ts']);
    expectUpdateMatchesRebuild(['notes/', 'a.ts'], ['a.ts']);
    expectUpdateMatchesRebuild(['a.ts'], ['notes/', 'a.ts']);
  });

  it('skips changes the tree already shows, as after its own drop of a folder', () => {
    const prevPaths = ['src/foo/a.ts', 'src/bar.ts', 'lib/x.ts'];
    const nextPaths = ['lib/foo/a.ts', 'src/bar.ts', 'lib/x.ts'];
    const tree = makeTree(prevPaths);
    tree.move('src/foo/', 'lib/foo/');

    tree.batch(planFileTreePathUpdate(prevPaths, nextPaths, hasPathIn(tree))!);

    expect(visiblePaths(tree)).toEqual(visiblePaths(makeTree(nextPaths)));
  });

  it('asks for a rebuild when a file and a folder swap a name', () => {
    const tree = makeTree(['foo/a.ts', 'b.ts']);
    expect(
      planFileTreePathUpdate(['foo/a.ts', 'b.ts'], ['foo', 'b.ts'], hasPathIn(tree))
    ).toBeNull();
    expect(planFileTreePathUpdate(['foo/', 'b.ts'], ['foo', 'b.ts'], hasPathIn(tree))).toBeNull();
    expect(
      planFileTreePathUpdate(['foo', 'b.ts'], ['foo/a.ts', 'b.ts'], hasPathIn(tree))
    ).toBeNull();
  });

  it('asks for a rebuild when most of the tree changed', () => {
    const prevPaths = Array.from({ length: 400 }, (_, i) => `old/f${i}.ts`);
    const nextPaths = Array.from({ length: 400 }, (_, i) => `new/f${i}.ts`);

    expect(planFileTreePathUpdate(prevPaths, nextPaths, () => true)).toBeNull();
  });

  it('still updates incrementally when a small tree changes a lot', () => {
    expectUpdateMatchesRebuild(['a.ts', 'b.ts'], ['c.ts', 'd.ts', 'e/f.ts']);
  });
});
