import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));
vi.mock('../../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));

describe('GitBlameService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup(mockExecResult?: string | Error) {
    const gitExecMod = await import('../../../../src/main/services/git/git-exec');
    const execSpy = vi.spyOn(gitExecMod.gitExec, 'execGitAsync');
    if (mockExecResult instanceof Error) {
      execSpy.mockRejectedValue(mockExecResult);
    } else if (mockExecResult !== undefined) {
      execSpy.mockResolvedValue(mockExecResult);
    }
    const { gitBlameService } = await import('../../../../src/main/services/git/git-blame');
    return { gitBlameService, execSpy };
  }

  it('returns empty array when git blame fails', async () => {
    const { gitBlameService } = await setup(new Error('not a git repo'));
    const result = await gitBlameService.getBlame('/repo', 'file.ts');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty output', async () => {
    const { gitBlameService } = await setup('   \n');
    const result = await gitBlameService.getBlame('/repo', 'file.ts');
    expect(result).toEqual([]);
  });

  it('parses single-line porcelain blame output', async () => {
    const hash = 'a'.repeat(40);
    const output = [
      `${hash} 1 1 1`,
      'author John Doe',
      'author-mail <john@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer John Doe',
      'committer-mail <john@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      'summary Initial commit',
      'filename file.ts',
      '\tconst x = 1',
      '',
    ].join('\n');

    const { gitBlameService } = await setup(output);
    const result = await gitBlameService.getBlame('/repo', 'file.ts');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      commitHash: hash,
      shortHash: hash.slice(0, 7),
      author: 'John Doe',
      authorEmail: 'john@example.com',
      timestamp: 1700000000,
      summary: 'Initial commit',
      startLine: 1,
      lineCount: 1,
    });
  });

  it('merges consecutive lines from the same commit into a single hunk', async () => {
    const hash = 'b'.repeat(40);
    // First line has metadata, second line reuses cached commit data
    const output = [
      `${hash} 1 1 2`,
      'author Alice',
      'author-mail <alice@test.com>',
      'author-time 1700000001',
      'author-tz +0000',
      'summary Add feature',
      'filename file.ts',
      '\tline one',
      `${hash} 2 2`,
      '\tline two',
      '',
    ].join('\n');

    const { gitBlameService } = await setup(output);
    const result = await gitBlameService.getBlame('/repo', 'file.ts');

    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(1);
    expect(result[0].lineCount).toBe(2);
    expect(result[0].author).toBe('Alice');
  });

  it('creates separate hunks for non-consecutive lines from different commits', async () => {
    const hashA = 'a'.repeat(40);
    const hashB = 'b'.repeat(40);
    const output = [
      `${hashA} 1 1 1`,
      'author Alice',
      'author-mail <alice@test.com>',
      'author-time 1700000000',
      'summary First commit',
      'filename file.ts',
      '\tline one',
      `${hashB} 2 2 1`,
      'author Bob',
      'author-mail <bob@test.com>',
      'author-time 1700000002',
      'summary Second commit',
      'filename file.ts',
      '\tline two',
      '',
    ].join('\n');

    const { gitBlameService } = await setup(output);
    const result = await gitBlameService.getBlame('/repo', 'file.ts');

    expect(result).toHaveLength(2);
    expect(result[0].author).toBe('Alice');
    expect(result[0].startLine).toBe(1);
    expect(result[1].author).toBe('Bob');
    expect(result[1].startLine).toBe(2);
  });

  it('passes commitHash argument when provided', async () => {
    const { gitBlameService, execSpy } = await setup('');
    await gitBlameService.getBlame('/repo', 'file.ts', 'abc123');
    expect(execSpy).toHaveBeenCalledWith('/repo', [
      'blame',
      '--porcelain',
      'abc123',
      '--',
      'file.ts',
    ]);
  });

  it('omits commitHash argument when not provided', async () => {
    const { gitBlameService, execSpy } = await setup('');
    await gitBlameService.getBlame('/repo', 'file.ts');
    expect(execSpy).toHaveBeenCalledWith('/repo', ['blame', '--porcelain', '--', 'file.ts']);
  });

  it('parses porcelain output with no trailing newline after the content line', async () => {
    const hash = 'd'.repeat(40);
    // No trailing empty element — last line is the \t content line itself
    const output = [
      `${hash} 1 1 1`,
      'author Eve',
      'author-mail <eve@example.com>',
      'author-time 1700000003',
      'summary Tail',
      'filename file.ts',
      '\tfinal line',
    ].join('\n');

    const { gitBlameService } = await setup(output);
    const result = await gitBlameService.getBlame('/repo', 'file.ts');

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('Eve');
    expect(result[0].startLine).toBe(1);
    expect(result[0].lineCount).toBe(1);
  });
});
