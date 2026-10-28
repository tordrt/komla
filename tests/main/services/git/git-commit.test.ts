import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

const { generateCommitMessage } = vi.hoisted(() => ({ generateCommitMessage: vi.fn() }));

vi.mock('../../../../src/main/services/utility-inference.service', () => ({
  utilityInferenceService: { generateCommitMessage },
}));

import { GitCommitService } from '../../../../src/main/services/git/git-commit';
import { gitExec } from '../../../../src/main/services/git/git-exec';

describe('GitCommitService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fsPromises.mkdtemp).mockReset().mockResolvedValue(join(tmpdir(), 'komla-message'));
    vi.mocked(fsPromises.writeFile).mockReset().mockResolvedValue();
    vi.mocked(fsPromises.rm).mockReset().mockResolvedValue();
    vi.spyOn(gitExec, 'execGitAsyncRawLimited').mockResolvedValue({
      output: '',
      truncated: false,
    });
    generateCommitMessage.mockReset().mockResolvedValue({ subject: 'Update behavior', body: null });
  });

  it('inspects commit scope without reading diffs or invoking utility inference', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce(
      'M  src/staged.ts\0 M src/unstaged.ts\0'
    );

    const result = await new GitCommitService().inspectScope('/repo');

    expect(result).toEqual({ scope: 'staged', fileCount: 1, stagedFileCount: 1, allFileCount: 2 });
    expect(gitExec.execGitAsyncRawLimited).not.toHaveBeenCalled();
    expect(generateCommitMessage).not.toHaveBeenCalled();
  });

  it('generates from all changes when asked, even when some are staged', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce(
      'M  src/staged.ts\0 M src/unstaged.ts\0?? new.txt\0'
    );
    vi.mocked(gitExec.execGitAsyncRawLimited).mockResolvedValueOnce({
      output: 'diff --git a/src/unstaged.ts b/src/unstaged.ts\n+change',
      truncated: false,
    });

    const result = await new GitCommitService().generateDraft('/repo', 'all');

    expect(result).toMatchObject({ scope: 'all', fileCount: 3 });
    expect(gitExec.execGitAsyncRawLimited).toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['diff', 'HEAD']),
      expect.any(Number)
    );
    expect(generateCommitMessage).toHaveBeenCalledWith(
      expect.stringContaining('--- untracked file: new.txt')
    );
  });

  it('refuses to generate from staged changes when nothing is staged', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce(' M src/unstaged.ts\0');

    await expect(new GitCommitService().generateDraft('/repo', 'staged')).rejects.toThrow(
      'There are no staged changes to commit'
    );
    expect(generateCommitMessage).not.toHaveBeenCalled();
  });

  it('generates from staged changes and does not stage or commit', async () => {
    const execRaw = vi.spyOn(gitExec, 'execGitAsyncRaw');
    execRaw.mockResolvedValueOnce('M  src/app.ts\0 M src/other.ts\0');
    vi.mocked(gitExec.execGitAsyncRawLimited).mockResolvedValueOnce({
      output: 'diff --git a/src/app.ts b/src/app.ts\n+safe change',
      truncated: false,
    });
    const exec = vi.spyOn(gitExec, 'execGitAsync');

    const result = await new GitCommitService().generateDraft('/repo');

    expect(result).toMatchObject({ scope: 'staged', subject: 'Update behavior' });
    expect(gitExec.execGitAsyncRawLimited).toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['--cached']),
      expect.any(Number)
    );
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.stringContaining('safe change'));
    expect(exec).not.toHaveBeenCalled();
  });

  it('includes untracked filenames without reading their contents or staging them', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce('?? new.txt\0');
    const exec = vi.spyOn(gitExec, 'execGitAsync');

    const result = await new GitCommitService().generateDraft('/repo');

    expect(result.scope).toBe('all');
    expect(generateCommitMessage).toHaveBeenCalledWith(
      expect.stringContaining('--- untracked file: new.txt\n[content omitted for safety]')
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('includes valid untracked filenames beginning with two dots', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce('?? ..config\0');

    await new GitCommitService().generateDraft('/repo');

    expect(generateCommitMessage).toHaveBeenCalledWith(expect.stringContaining('..config'));
  });

  it('only includes filenames reported by Git status', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce('?? visible.txt\0');

    await new GitCommitService().generateDraft('/repo');

    const inferenceInput = generateCommitMessage.mock.calls[0]?.[0] as string;
    expect(inferenceInput).toContain('visible.txt');
    expect(inferenceInput).not.toContain('ignored.txt');
    expect(gitExec.execGitAsyncRaw).toHaveBeenCalledWith('/repo', [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
  });

  it('does not inspect untracked files after the diff limit is reached', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce(
      ' M tracked.txt\0?? untracked.txt\0'
    );
    vi.mocked(gitExec.execGitAsyncRawLimited).mockImplementationOnce(
      async (_repoPath, _args, maxChars) => ({
        output: 'x'.repeat(maxChars),
        truncated: true,
      })
    );
    await new GitCommitService().generateDraft('/repo');

    expect(generateCommitMessage).toHaveBeenCalledWith(
      expect.not.stringContaining('untracked.txt')
    );
  });

  it('preserves a bounded tracked diff prefix when Git output is truncated', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce(' M tracked.txt\0');
    vi.mocked(gitExec.execGitAsyncRawLimited).mockResolvedValueOnce({
      output: 'diff prefix with important change',
      truncated: true,
    });

    await new GitCommitService().generateDraft('/repo');

    const inferenceInput = generateCommitMessage.mock.calls[0]?.[0] as string;
    expect(inferenceInput).toContain('diff prefix with important change');
    expect(inferenceInput).toContain('[...diff truncated...]');
  });

  it('preserves the detected scope when commit-message generation fails', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValueOnce('M  tracked.txt\0');
    vi.mocked(gitExec.execGitAsyncRawLimited).mockResolvedValueOnce({
      output: 'diff content',
      truncated: false,
    });
    generateCommitMessage.mockRejectedValueOnce(new Error('Utility inference is unavailable'));

    const result = await new GitCommitService().generateDraft('/repo');

    expect(result).toEqual({
      subject: '',
      body: null,
      scope: 'staged',
      fileCount: 1,
      generationError: 'Utility inference is unavailable',
    });
  });

  it('stages all only after explicit all-scope commit confirmation', async () => {
    const sequence = vi
      .spyOn(gitExec, 'execGitWriteSequence')
      .mockResolvedValue(['', '', 'abc123']);

    const result = await new GitCommitService().commit('/repo', {
      subject: 'Add files',
      body: 'Include the generated assets.',
      scope: 'all',
    });

    const messagePath = join(tmpdir(), 'komla-message', 'COMMIT_EDITMSG');
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      messagePath,
      'Add files\n\nInclude the generated assets.',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    expect(sequence).toHaveBeenCalledWith('/repo', [
      ['add', '--all'],
      ['commit', '-F', messagePath],
      ['rev-parse', 'HEAD'],
    ]);
    expect(fsPromises.rm).toHaveBeenCalledWith(join(tmpdir(), 'komla-message'), {
      recursive: true,
      force: true,
    });
    expect(result.commitHash).toBe('abc123');
  });

  it('writes large commit bodies to a file instead of command-line arguments', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValue('src/app.ts');
    const sequence = vi.spyOn(gitExec, 'execGitWriteSequence').mockResolvedValue(['', 'abc123']);
    const body = 'x'.repeat(100_000);

    await new GitCommitService().commit('/repo', {
      subject: 'Document generated output',
      body,
      scope: 'staged',
    });

    const messagePath = join(tmpdir(), 'komla-message', 'COMMIT_EDITMSG');
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      messagePath,
      `Document generated output\n\n${body}`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    expect(sequence).toHaveBeenCalledWith('/repo', [
      ['commit', '-F', messagePath],
      ['rev-parse', 'HEAD'],
    ]);
  });

  it('surfaces hook or identity failures and does not bypass hooks', async () => {
    vi.spyOn(gitExec, 'execGitAsyncRaw').mockResolvedValue('src/app.ts');
    const sequence = vi
      .spyOn(gitExec, 'execGitWriteSequence')
      .mockRejectedValue(new Error('Author identity unknown'));

    await expect(
      new GitCommitService().commit('/repo', { subject: 'Update app', scope: 'staged' })
    ).rejects.toThrow('Author identity unknown');
    expect(sequence).toHaveBeenCalledWith('/repo', [
      ['commit', '-F', join(tmpdir(), 'komla-message', 'COMMIT_EDITMSG')],
      ['rev-parse', 'HEAD'],
    ]);
    expect(fsPromises.rm).toHaveBeenCalled();
  });
});
