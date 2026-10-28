/**
 * A folder without git has no `git ls-files`, so the file tree walks it instead.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listFolderFiles } from '../../../../src/main/services/git/list-folder-files';

describe('listFolderFiles', () => {
  let root: string;

  const write = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), '');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-folder-files-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists dotfiles and files in dot folders', async () => {
    write('.env');
    write('.github/workflows/ci.yml');
    write('notes.md');
    expect((await listFolderFiles(root)).sort()).toEqual([
      '.env',
      '.github/workflows/ci.yml',
      'notes.md',
    ]);
  });

  it('leaves out dependency, cache and version control folders', async () => {
    write('node_modules/pkg/index.js');
    write('app/node_modules/pkg/index.js');
    write('.venv/bin/python');
    write('src/__pycache__/main.cpython-312.pyc');
    write('.git/HEAD');
    write('.DS_Store');
    write('src/main.py');
    expect(await listFolderFiles(root)).toEqual(['src/main.py']);
  });

  it('stops at the limit, keeping files near the top before deep ones', async () => {
    write('deep/a/b/c/1.txt');
    write('deep/a/b/c/2.txt');
    write('deep/a/b/c/3.txt');
    write('top.txt');
    write('deep/mid.txt');
    expect(await listFolderFiles(root, { limit: 2 })).toEqual(['top.txt', 'deep/mid.txt']);
  });

  it('skips folders it cannot read and returns nothing for a missing folder', async () => {
    expect(await listFolderFiles(join(root, 'missing'))).toEqual([]);
  });
});
