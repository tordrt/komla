import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addGitExcludeRule,
  resolveGitExcludePath,
} from '../../../../src/main/services/git/git-exclude';

describe('git exclude', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-git-exclude-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A checkout at `<root>/main` and a worktree of it at `<root>/<name>`, laid out as git does. */
  function makeWorktree(name: string): string {
    mkdirSync(join(root, 'main', '.git', 'worktrees', name), { recursive: true });
    writeFileSync(join(root, 'main', '.git', 'worktrees', name, 'commondir'), '../..\n');
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, '.git'),
      `gitdir: ${join(root, 'main', '.git', 'worktrees', name)}\n`
    );
    return join(root, name);
  }

  it("resolves a checkout's own exclude file", async () => {
    mkdirSync(join(root, 'main', '.git'), { recursive: true });

    expect(await resolveGitExcludePath(join(root, 'main'))).toBe(
      join(root, 'main', '.git', 'info', 'exclude')
    );
  });

  it("resolves a worktree's exclude file to the common gitdir, the only one git reads", async () => {
    const worktree = makeWorktree('feature');

    expect(await resolveGitExcludePath(worktree)).toBe(
      join(root, 'main', '.git', 'info', 'exclude')
    );
  });

  it('resolves to the gitdir a .git file names when it has no commondir', async () => {
    mkdirSync(join(root, 'main', '.git', 'modules', 'sub'), { recursive: true });
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', '.git'), 'gitdir: ../main/.git/modules/sub\n');

    expect(await resolveGitExcludePath(join(root, 'sub'))).toBe(
      join(root, 'main', '.git', 'modules', 'sub', 'info', 'exclude')
    );
  });

  it('fails instead of guessing when commondir exists but cannot be read', async () => {
    const worktree = makeWorktree('feature');
    const commondir = join(root, 'main', '.git', 'worktrees', 'feature', 'commondir');
    rmSync(commondir);
    mkdirSync(commondir);

    await expect(resolveGitExcludePath(worktree)).rejects.toThrow();
  });

  it('returns null outside a checkout', async () => {
    expect(await resolveGitExcludePath(root)).toBeNull();
  });

  it('adds a rule once under its header, after existing content without a final newline', async () => {
    mkdirSync(join(root, 'main', '.git', 'info'), { recursive: true });
    const excludePath = join(root, 'main', '.git', 'info', 'exclude');
    writeFileSync(excludePath, 'existing-rule');

    await addGitExcludeRule(join(root, 'main'), '# header', '/rule/*');
    await addGitExcludeRule(join(root, 'main'), '# header', '/rule/*');

    expect(readFileSync(excludePath, 'utf-8')).toBe('existing-rule\n# header\n/rule/*\n');
  });

  it('keeps every rule when worktrees sharing one exclude file add rules at once', async () => {
    const worktrees = Array.from({ length: 10 }, (_, index) => makeWorktree(`wt-${index}`));

    await Promise.all(
      worktrees.map((worktree, index) =>
        addGitExcludeRule(worktree, '# header', `/rule-${index}/*`)
      )
    );

    const lines = readFileSync(join(root, 'main', '.git', 'info', 'exclude'), 'utf-8').split('\n');
    for (let index = 0; index < worktrees.length; index++) {
      expect(lines).toContain(`/rule-${index}/*`);
    }
  });
});
