import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspace } from '../../factories';
import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

let base: string;
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => base,
}));
// Only Windows retries a folder opencode holds; the delete itself is what's under test.
vi.mock('../../../src/main/lib/opencode-service', () => ({
  deleteReleasingOpenCodeLocation: (_folder: string, remove: () => Promise<void>) => remove(),
}));

const { createScratchFolder, isScratchFolder, removeScratchFolder, scratchRoot } =
  await import('../../../src/main/services/workspace/scratch');

describe('scratch folders', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'komla-scratch-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('makes an empty folder of its own in the scratch root', () => {
    const first = createScratchFolder();
    const second = createScratchFolder();

    expect(first.path).toBe(join(base, 'scratch', first.suffix));
    expect(readdirSync(first.path)).toEqual([]);
    expect(second.path).not.toBe(first.path);
    expect(first.suffix).toMatch(/^[a-z]+-[a-z]+/);
  });

  it('never hands out a folder that is already there', () => {
    mkdirSync(scratchRoot(), { recursive: true });
    const taken = createScratchFolder();
    writeFileSync(join(taken.path, 'notes.md'), 'keep me');

    for (let i = 0; i < 50; i++) expect(createScratchFolder().path).not.toBe(taken.path);
    expect(existsSync(join(taken.path, 'notes.md'))).toBe(true);
  });

  it('counts only folders directly in the scratch root as scratch folders', () => {
    expect(isScratchFolder(join(base, 'scratch', 'swift-fox'))).toBe(true);
    expect(isScratchFolder(scratchRoot())).toBe(false);
    expect(isScratchFolder(join(base, 'scratch', 'swift-fox', 'inner'))).toBe(false);
    expect(isScratchFolder(join(base, 'scratch', '..', 'worktrees'))).toBe(false);
    expect(isScratchFolder(join(base, 'projects'))).toBe(false);
    expect(isScratchFolder('')).toBe(false);
  });

  it('deletes a scratch workspace’s folder with everything in it', async () => {
    const { path } = createScratchFolder();
    mkdirSync(join(path, 'src'));
    writeFileSync(join(path, 'src', 'index.ts'), 'export {};');

    await removeScratchFolder(createWorkspace({ workingDirectory: path, scratch: true }));

    expect(existsSync(path)).toBe(false);
    expect(existsSync(scratchRoot())).toBe(true);
  });

  it('leaves a folder outside the scratch root, even when a scratch workspace names it', async () => {
    const own = join(base, 'my-project');
    mkdirSync(own);
    createScratchFolder();
    writeFileSync(join(own, 'README.md'), 'mine');

    await removeScratchFolder(createWorkspace({ workingDirectory: own, scratch: true }));
    await removeScratchFolder(createWorkspace({ workingDirectory: scratchRoot(), scratch: true }));

    expect(existsSync(join(own, 'README.md'))).toBe(true);
    expect(existsSync(scratchRoot())).toBe(true);
  });

  it('leaves the folder of a workspace that is no longer scratch', async () => {
    const { path } = createScratchFolder();

    await removeScratchFolder(createWorkspace({ workingDirectory: path }));

    expect(existsSync(path)).toBe(true);
  });
});
