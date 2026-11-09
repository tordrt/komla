import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removePathInChild } from '../../../src/main/lib/remove-path';

describe('removePathInChild', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-remove-in-child-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a directory tree', async () => {
    const tree = join(root, 'node_modules');
    mkdirSync(join(tree, 'pkg', 'lib'), { recursive: true });
    writeFileSync(join(tree, 'pkg', 'lib', 'index.js'), 'x');
    writeFileSync(join(tree, 'top.js'), 'x');

    await removePathInChild(tree);

    expect(existsSync(tree)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('removes a single file', async () => {
    const file = join(root, 'file.txt');
    writeFileSync(file, 'x');

    await removePathInChild(file);

    expect(existsSync(file)).toBe(false);
  });

  it('succeeds when the path is already gone', async () => {
    await expect(removePathInChild(join(root, 'missing'))).resolves.toBeUndefined();
  });

  it('keeps a path with spaces and shell characters intact', async () => {
    const tree = join(root, 'my deps; echo $HOME');
    mkdirSync(tree);
    writeFileSync(join(tree, 'a.js'), 'x');
    writeFileSync(join(root, 'sibling.txt'), 'x');

    await removePathInChild(tree);

    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(root, 'sibling.txt'))).toBe(true);
  });

  it("ignores the app's NODE_OPTIONS, which could load other code into the delete", async () => {
    const tree = join(root, 'node_modules');
    mkdirSync(tree);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require ${join(root, 'does-not-exist.js')}`;
    try {
      await removePathInChild(tree);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }

    expect(existsSync(tree)).toBe(false);
  });
});
