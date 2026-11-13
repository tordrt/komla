import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(userData.dir, name === 'userData' ? '' : name) },
}));

import {
  MAX_STAGED_ATTACHMENT_BYTES,
  stagePromptAttachments,
  sweepStagedAttachments,
} from '../../../../src/main/services/workspace/staged-attachments';

describe('stagePromptAttachments', () => {
  let sourceDir: string;
  const stagingDir = () => join(userData.dir, 'staged-attachments');

  beforeEach(() => {
    userData.dir = mkdtempSync(join(tmpdir(), 'komla-staged-data-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'komla-staged-source-'));
  });

  afterEach(() => {
    rmSync(userData.dir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('keeps a copy of a dropped file that its app deletes after the drop', async () => {
    const source = join(sourceDir, 'simulator_screenshot.png');
    writeFileSync(source, 'png bytes');

    const [staged] = await stagePromptAttachments([source]);
    rmSync(source);

    expect(basename(staged)).toBe('simulator_screenshot.png');
    expect(dirname(dirname(staged))).toBe(stagingDir());
    expect(readFileSync(staged, 'utf8')).toBe('png bytes');
  });

  it('gives files of the same name a folder each', async () => {
    const first = join(sourceDir, 'a', 'shot.png');
    const second = join(sourceDir, 'b', 'shot.png');
    mkdirSync(dirname(first));
    mkdirSync(dirname(second));
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');

    const staged = await stagePromptAttachments([first, second]);

    expect(staged.map((path) => readFileSync(path, 'utf8'))).toEqual(['first', 'second']);
  });

  it('leaves a path it cannot copy as it is, for creation to report, and keeps nothing', async () => {
    const missing = join(sourceDir, 'gone.png');

    await expect(stagePromptAttachments([missing, sourceDir])).resolves.toEqual([
      missing,
      sourceDir,
    ]);
    expect(readdirSync(stagingDir())).toEqual([]);
  });

  it('takes a file too large to copy quickly where it is', async () => {
    const large = join(sourceDir, 'recording.mov');
    writeFileSync(large, '');
    truncateSync(large, MAX_STAGED_ATTACHMENT_BYTES + 1);

    await expect(stagePromptAttachments([large])).resolves.toEqual([large]);
  });

  it('clears out files staged over a week ago', async () => {
    const dir = join(userData.dir, 'old-staging');
    mkdirSync(join(dir, 'old'), { recursive: true });
    mkdirSync(join(dir, 'recent'));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'old'), eightDaysAgo, eightDaysAgo);

    await sweepStagedAttachments(dir);

    expect(readdirSync(dir)).toEqual(['recent']);
  });

  it('sweeps the temp folder pasted images were staged in before', async () => {
    vi.resetModules();
    const { stagePromptAttachments: stage } =
      await import('../../../../src/main/services/workspace/staged-attachments');
    const legacy = join(userData.dir, 'temp', 'komla-clipboard-images', 'staged');
    mkdirSync(join(legacy, 'old'), { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(legacy, 'old'), eightDaysAgo, eightDaysAgo);
    const source = join(sourceDir, 'shot.png');
    writeFileSync(source, 'x');

    await stage([source]);

    await vi.waitFor(() => expect(readdirSync(legacy)).toEqual([]));
  });

  it('stages a file where it is when the staging folder cannot be made', async () => {
    const source = join(sourceDir, 'shot.png');
    writeFileSync(source, 'x');
    // A file where the folder should be.
    writeFileSync(stagingDir(), '');

    await expect(stagePromptAttachments([source])).resolves.toEqual([source]);
  });
});
